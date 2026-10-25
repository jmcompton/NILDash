'use strict';
// ── THE SALES MAILBOX: JOHNMARK'S OWN OUTLOOK, THROUGH MICROSOFT GRAPH ──────
//
// The sales autopilot (services/salesAutopilot) sends from SALES_FROM_ADDRESS
// (john@comptongroupllc.com), the connected Microsoft 365 mailbox, so SPF and
// DKIM are Microsoft's own and line up. No third-party sending service.
//
// What it does here, and the permission each needs:
//   send a new email, plain text           Mail.Send   (POST /me/sendMail)
//   reply inside the same thread           Mail.Send   (POST /me/messages/{id}/reply)
//   find the sent message to reply to      Mail.Read   (Sent Items)
//   read the inbox for replies and bounces Mail.Read
//   move a reply to "NILDash Prospects"    Mail.ReadWrite (mailFolders, move)
//   see a demo booked on the calendar      Calendars.Read
// Mail.ReadWrite is asked for by one route only, the admin's sales connect
// (/admin/sales/connect-mailbox); no customer is ever asked for it. Without
// it, replies are still read and tagged, and the report says they could not
// be moved.
//
// Plain text only: the body goes as contentType Text. Nothing is added: no
// image, no pixel, no rewritten link.

const GRAPH = 'https://graph.microsoft.com/v1.0';
const lc = (s) => String(s || '').trim().toLowerCase();
const FOLDER = 'NILDash Prospects';

function fromAddress() { return lc(process.env.SALES_FROM_ADDRESS || 'john@comptongroupllc.com'); }

// ── WHICH MAILBOX ─────────────────────────────────────────────────────────
// The email_accounts row for SALES_FROM_ADDRESS on Outlook, connected under
// the admin login (ADMIN_EMAIL) or a founder. Anyone else's row with the same
// address is never used.
async function account(pool) {
  const addr = fromAddress();
  const admin = String(process.env.ADMIN_EMAIL || 'johnmarkcompton@gmail.com').trim().toLowerCase();
  const founders = String(process.env.FOUNDER_EMAILS || '').split(',').map(lc).filter(Boolean);
  const rows = (await pool.query(
    `SELECT ea.id, ea.user_id, ea.provider, ea.email_address, ea.status, ea.can_send, ea.granted_scopes, u.email AS owner
       FROM email_accounts ea JOIN users u ON u.id = ea.user_id
      WHERE LOWER(ea.email_address) = $1 AND ea.provider IN ('outlook', 'microsoft365')`, [addr]).catch(() => ({ rows: [] }))).rows;
  const row = rows.find((r) => [admin, ...founders].includes(lc(r.owner)) && lc(r.status || 'active') !== 'disconnected');
  if (!row) {
    return { ok: false, address: addr, why: `${addr} is not connected as an Outlook mailbox under the admin login. Connect it at /admin/sales/connect-mailbox.` };
  }
  const granted = Array.isArray(row.granted_scopes) ? row.granted_scopes : String(row.granted_scopes || '').split(/[\s,]+/).filter(Boolean);
  const has = (re) => granted.some((g) => re.test(String(g)));
  const unknown = !granted.length;   // an older row: the scopes were not recorded
  return {
    ok: true, address: addr, accountId: row.id, userId: row.user_id,
    canSend: row.can_send !== false && (unknown || has(/Mail\.Send$/i)),
    canRead: unknown || has(/Mail\.Read(Write)?$/i),
    canMove: has(/Mail\.ReadWrite$/i),
    canCalendar: has(/Calendars\.Read(Write)?$/i),
  };
}

async function accessToken(mb) {
  const full = await require('./emailStore').getEmailAccountWithTokens(mb.accountId);
  if (!full || !full.accessToken) throw graphError(401, 'NoToken', `no access token for ${mb.address}; reconnect it at /admin/sales/connect-mailbox`);
  return full.accessToken;
}

function graphError(status, code, message, extra) {
  const e = new Error(`Graph ${status}${code ? ' ' + code : ''}: ${message}`);
  e.status = status; e.code = code || null; Object.assign(e, extra || {});
  return e;
}

// One Graph call. Immutable ids, so a message keeps its id when it moves
// from Drafts to Sent Items or into the prospects folder.
async function graph(mb, method, path, body, deps = {}) {
  if (deps.graph) return deps.graph(method, path, body);
  const token = await accessToken(mb);
  const f = deps.fetchImpl || fetch;
  const r = await f(path.startsWith('http') ? path : GRAPH + path, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', prefer: 'IdType="ImmutableId", outlook.body-content-type="text"' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let j = null; try { j = text ? JSON.parse(text) : null; } catch (_) { j = null; }
  if (!r.ok) {
    const err = (j && j.error) || {};
    throw graphError(r.status, err.code, err.message || text.slice(0, 200), { retryAfter: r.headers && r.headers.get ? r.headers.get('retry-after') : null });
  }
  return j || {};
}

async function getAll(mb, path, deps = {}, maxPages = 10) {
  const out = [];
  let next = path;
  for (let i = 0; next && i < maxPages; i++) {
    const j = await graph(mb, 'GET', next, undefined, deps);
    for (const v of (j.value || [])) out.push(v);
    next = j['@odata.nextLink'] || null;
  }
  return out;
}

// ── A SEND THAT MICROSOFT LIMITED ─────────────────────────────────────────
// Throttled, over the sending quota, or the account restricted for outbound
// spam: the autopilot stops for the day and tells JohnMark.
const LIMIT_TEXT = /exceed|quota|limit|throttl|outbound ?spam|OutboundSpamException|SubmissionQuota|MessageSubmissionRate|5\.2\.0 STOREDRV|5\.1\.90|5\.7\.708|5\.1\.8|blocked from sending|restricted from sending|sending limit/i;
function isSendLimit(e) {
  if (!e) return false;
  if (Number(e.status) === 429) return true;
  return LIMIT_TEXT.test(`${e.code || ''} ${e.message || ''}`);
}

// ── SEND ──────────────────────────────────────────────────────────────────
const recipient = (to) => [{ emailAddress: { address: to } }];

// A new email. Returns { messageId, conversationId, internetMessageId }, read
// back from Sent Items (sendMail itself returns nothing); null ids when it
// is not there yet, and the follow-up finds it later (findSent).
async function sendNew(mb, { to, subject, text }, deps = {}) {
  const t0 = new Date(Date.now() - 60000);
  await graph(mb, 'POST', '/me/sendMail', {
    message: { subject, body: { contentType: 'Text', content: text }, toRecipients: recipient(to) },
    saveToSentItems: true,
  }, deps);
  const found = await findSent(mb, { to, subject, since: t0 }, deps).catch(() => null);
  return found || { messageId: null, conversationId: null, internetMessageId: null };
}

// The message we sent to `to` with `subject`, from Sent Items.
async function findSent(mb, { to, subject, since }, deps = {}) {
  const iso = new Date(since || Date.now() - 30 * 86400000).toISOString();
  const rows = await getAll(mb, `/me/mailFolders/sentitems/messages?$filter=sentDateTime ge ${iso}&$orderby=sentDateTime desc&$top=50`
    + '&$select=id,conversationId,internetMessageId,subject,toRecipients,sentDateTime', deps, 4);
  const hit = rows.find((m) => (m.toRecipients || []).some((r) => lc(r.emailAddress && r.emailAddress.address) === lc(to))
    && (!subject || String(m.subject || '').trim() === String(subject).trim()));
  return hit ? { messageId: hit.id, conversationId: hit.conversationId || null, internetMessageId: hit.internetMessageId || null } : null;
}

// A reply in the thread of `messageId`, plain text, to `to` only.
async function reply(mb, { messageId, to, text }, deps = {}) {
  await graph(mb, 'POST', `/me/messages/${encodeURIComponent(messageId)}/reply`, {
    message: { toRecipients: recipient(to), body: { contentType: 'Text', content: text } },
  }, deps);
  return { messageId: null };
}

// ── READ ──────────────────────────────────────────────────────────────────
const MSG_FIELDS = 'id,conversationId,internetMessageId,subject,from,sender,toRecipients,receivedDateTime,bodyPreview,body,internetMessageHeaders,parentFolderId';
async function inboxSince(mb, since, deps = {}) {
  const iso = new Date(since).toISOString();
  return getAll(mb, `/me/mailFolders/inbox/messages?$filter=receivedDateTime ge ${iso}&$orderby=receivedDateTime asc&$top=50&$select=${MSG_FIELDS}`, deps, 10);
}
async function thread(mb, conversationId, deps = {}) {
  return getAll(mb, `/me/messages?$filter=conversationId eq '${String(conversationId).replace(/'/g, "''")}'&$top=25&$select=${MSG_FIELDS}`, deps, 2);
}
async function calendar(mb, from, to, deps = {}) {
  return getAll(mb, `/me/calendarView?startDateTime=${new Date(from).toISOString()}&endDateTime=${new Date(to).toISOString()}&$top=100`
    + '&$select=id,subject,start,createdDateTime,attendees,organizer,isCancelled', deps, 4);
}

// ── THE FOLDER ────────────────────────────────────────────────────────────
async function ensureFolder(mb, deps = {}, name = FOLDER) {
  const found = await getAll(mb, `/me/mailFolders?$filter=displayName eq '${name.replace(/'/g, "''")}'&$select=id,displayName`, deps, 1);
  if (found.length) return found[0].id;
  const made = await graph(mb, 'POST', '/me/mailFolders', { displayName: name }, deps);
  return made.id;
}
async function move(mb, messageId, folderId, deps = {}) {
  return graph(mb, 'POST', `/me/messages/${encodeURIComponent(messageId)}/move`, { destinationId: folderId }, deps);
}

// The text of a Graph message, plain.
function textOf(m) {
  const b = (m && m.body) || {};
  const raw = String(b.content || m.bodyPreview || '');
  if (String(b.contentType || '').toLowerCase() === 'html') {
    return raw.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
  }
  return raw.trim();
}
const fromOf = (m) => lc(((m && (m.from || m.sender)) || {}).emailAddress && (m.from || m.sender).emailAddress.address);

module.exports = { account, graph, getAll, sendNew, findSent, reply, inboxSince, thread, calendar, ensureFolder, move, textOf, fromOf,
  isSendLimit, fromAddress, FOLDER, LIMIT_TEXT, GRAPH };
