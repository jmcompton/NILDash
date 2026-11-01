'use strict';
// ── PROSPECTOR OUTREACH: SELLING PROSPECTOR TO IT COMPANIES, BY ITSELF ──────
//
// The cold emails to IT company owners ("3 businesses near you with an email
// gap"), sent from Prospector's own mailboxes (PROSPECTOR_FROM_ADDRESS, one or
// more, comma separated), each an Outlook mailbox connected under the admin
// login through Microsoft Graph, the same plumbing as services/salesMailbox.
//
// THE LIFE OF ONE PROSPECT
//   draft     imported, waiting for JohnMark's OK (the approve button). With
//             PROSPECTOR_AUTOSEND_ON, an import skips this and is queued.
//   queued    approved; the next free mailbox sends the first email.
//   active    first email sent; follow-up 1 on day 3, follow-up 2 on day 7,
//             both inside the same thread, from the same mailbox.
//   done      all three sent, no answer.
//   replied   they wrote back. The sequence stops whatever they said.
//   stopped   bounced, unsubscribed, removed, or an error that kept repeating.
//
// AN INTERESTED REPLY ("yes", "send them", "how much?") gets its free sample
// at once: a Prospector run of 10 businesses in their area, signed with their
// company (services/prospector/samples), and the link is sent back in the
// thread when PROSPECTOR_AUTOSEND_ON. The page shows the leads and the plans;
// they buy there, with no call. JohnMark is told about every human reply.
//
// THE LIMITS, PER MAILBOX: weekdays 9:00 to 16:00 Central, 4 minutes apart,
// 10 a day on the first sending day and 3 more each sending day after, to 30.
// Follow-ups count. Microsoft limiting a mailbox stops that mailbox for the
// day; bounces over 2% stop everything until resumed.
//
// Nothing is sent while PROSPECTOR_OUTREACH_ON is off, or without
// BUSINESS_MAILING_ADDRESS (CAN-SPAM: every email carries it, with an
// unsubscribe link that feeds the same suppression list as NILDash).

const MB = require('../salesMailbox');
const SR = require('../salesReplies');
const canSpam = require('../canSpam');
const suppression = require('../suppression');

const lc = (s) => String(s || '').trim().toLowerCase();
const clip = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const yes = (k) => /^(1|true|yes|on)$/i.test(String(process.env[k] || '').trim());
const num = (k, d) => { const n = Number(process.env[k]); return Number.isFinite(n) && n > 0 ? n : d; };

const ON = () => yes('PROSPECTOR_OUTREACH_ON');
const AUTOSEND = () => yes('PROSPECTOR_AUTOSEND_ON');
const WARMUP_START = () => num('PROSPECTOR_WARMUP_START', 10);
const WARMUP_STEP = () => num('PROSPECTOR_WARMUP_STEP', 3);
const DAILY_CAP = () => num('PROSPECTOR_DAILY_CAP', 30);
const GAP_MS = () => num('PROSPECTOR_GAP_MINUTES', 4) * 60000;
const WINDOW_FROM = 9 * 60, WINDOW_TO = 16 * 60;
const FOLLOW_UP_DAYS = [3, 7];
const BOUNCE_LIMIT = 0.02, BOUNCE_MIN_SENDS = 20, BOUNCE_DAYS = 14;
const MAX_ERRORS = 3;
const CENTRAL = 'America/Chicago';
const FOLDER = 'Prospector';
const STATES = ['draft', 'queued', 'active', 'done', 'replied', 'stopped'];

function mailboxes() {
  return String(process.env.PROSPECTOR_FROM_ADDRESS || '').split(/[\s,;]+/).map(lc).filter((e) => /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(e));
}
function senderName() { return clip(process.env.PROSPECTOR_SENDER_NAME, 80) || 'JohnMark Compton'; }
function senderCompany() { return clip(process.env.PROSPECTOR_SENDER_COMPANY, 80) || 'Compton Group'; }
function appUrl() { return String(process.env.PROSPECTOR_BASE_URL || process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, ''); }
const firstWord = (n) => clip(n, 60).split(/\s+/)[0] || '';
const domainOf = (e) => (lc(e).match(/@([a-z0-9.-]+\.[a-z]{2,})$/) || [])[1] || null;

// ── TABLES ──────────────────────────────────────────────────────────────────
let _ensured = false;
async function ensureTables(pool) {
  if (_ensured) return;
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_outreach (
    id SERIAL PRIMARY KEY, email TEXT NOT NULL UNIQUE, domain TEXT,
    first_name TEXT, last_name TEXT, company TEXT, area TEXT,
    subject TEXT NOT NULL, body TEXT NOT NULL, fu1 TEXT, fu2 TEXT,
    source TEXT, batch TEXT, state TEXT NOT NULL DEFAULT 'draft', step INT NOT NULL DEFAULT 0,
    mailbox TEXT, next_at TIMESTAMPTZ, sending_at TIMESTAMPTZ, errors INT NOT NULL DEFAULT 0, last_error TEXT,
    message_id TEXT, conversation_id TEXT, first_sent_at TIMESTAMPTZ, last_sent_at TIMESTAMPTZ,
    reply_tag TEXT, replied_at TIMESTAMPTZ, reply_text TEXT, sample_token TEXT, answered_at TIMESTAMPTZ,
    stop_reason TEXT, approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS prospector_outreach_due ON prospector_outreach (state, next_at)`);
  await pool.query(`CREATE INDEX IF NOT EXISTS prospector_outreach_domain ON prospector_outreach (domain)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_outreach_events (
    id SERIAL PRIMARY KEY, outreach_id INT, kind TEXT NOT NULL, step INT, mailbox TEXT, detail TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`CREATE INDEX IF NOT EXISTS prospector_outreach_events_kind ON prospector_outreach_events (kind, at)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS prospector_outreach_state (
    id INT PRIMARY KEY DEFAULT 1, paused BOOLEAN NOT NULL DEFAULT FALSE, paused_reason TEXT, paused_at TIMESTAMPTZ,
    cursors JSONB NOT NULL DEFAULT '{}', limited JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await pool.query(`INSERT INTO prospector_outreach_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
  _ensured = true;
}
async function getState(pool) {
  await ensureTables(pool);
  const r = (await pool.query(`SELECT * FROM prospector_outreach_state WHERE id = 1`)).rows[0] || {};
  return { ...r, cursors: r.cursors || {}, limited: r.limited || {} };
}
async function event(pool, id, kind, extra = {}) {
  await pool.query(`INSERT INTO prospector_outreach_events (outreach_id, kind, step, mailbox, detail, at) VALUES ($1,$2,$3,$4,$5,COALESCE($6, NOW()))`,
    [id || null, kind, extra.step == null ? null : extra.step, extra.mailbox || null, extra.detail == null ? null : clip(extra.detail, 2000),
      extra.at ? new Date(extra.at) : null]).catch(() => {});
}

// ── TIME ────────────────────────────────────────────────────────────────────
function central(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(now)).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}
function inWindow(now) {
  const c = central(now);
  if (c.weekday === 'Sat' || c.weekday === 'Sun') return { ok: false, why: 'weekend', today: c.date };
  if (c.minutes < WINDOW_FROM || c.minutes >= WINDOW_TO) return { ok: false, why: 'outside 9:00 to 16:00 Central', today: c.date };
  return { ok: true, today: c.date };
}

// ── THE EMAILS ──────────────────────────────────────────────────────────────
// The first email, from up to three businesses near them that have a gap and
// the numbers of the run they came from. Same words as the hand-built batch.
function compose(p) {
  const first = firstWord(p.first || p.first_name);
  const area = clip(p.area, 120) || 'your area';
  const picks = (Array.isArray(p.picks) ? p.picks : []).filter((x) => x && (x.business || x.name)).slice(0, 3);
  if (!picks.length) return null;
  const line = (x) => {
    const where = [clip(x.kind || x.category, 60), clip(x.town, 60)].filter(Boolean).join(', ');
    return `${clip(x.business || x.name, 120)}${where ? ` (${where})` : ''}: ${clip(x.gap || x.problem, 160) || 'an email security gap'}`;
  };
  const stats = p.checked && p.withGap ? ` ${p.withGap} of the ${p.checked} businesses I checked have a gap.` : '';
  const greet = first ? `Hi ${first},` : 'Hi there,';
  const n = picks.length === 1 ? 'One' : picks.length === 2 ? 'Two' : 'Three';
  const body = `${greet}

I run a small software company. We built a tool that checks the public email records of local businesses and flags the ones anyone could impersonate.

I ran it in the ${area} area this week.${stats} ${n} near you:

${picks.map(line).join('\n')}

Each one is a fix your team could knock out in an afternoon, and an easy reason to start a conversation.

I put together 10 more in your area with the decision maker's verified email and a first email already written, signed with your company's name. Want them? It's free. Just reply and I'll send them over.

${senderName()}
${senderCompany()}`;
  return { subject: `${picks.length} business${picks.length === 1 ? '' : 'es'} near you with an email gap`, body };
}
function followUp(p, n) {
  const first = firstWord(p.first_name);
  const greet = first ? `Hi ${first},` : 'Hi there,';
  const area = clip(p.area, 120) || 'your area';
  const me = firstWord(senderName());
  if (n === 1) return `${greet}\n\nQuick follow-up. The 10 for the ${area} area are ready to go. Reply "send" and they're yours.\n\n${me}`;
  return `${greet}\n\nLast note on this. We work with one IT company per area so the leads stay exclusive to them, and ${area} is still open.\n\nIf now isn't the time, no worries.\n\n${me}`;
}
// The answer to an interested reply: the link to their free sample.
function answerText(p, link) {
  const first = firstWord(p.first_name);
  const area = clip(p.area, 120) || 'your area';
  return `${first ? `Hi ${first},` : 'Hi,'}

Here they are: ${link}

10 businesses in ${area} with an email security gap, the decision maker's email, and a first email written for each one, signed from ${clip(p.company, 120) || 'your company'}. The first time you open it, give it about 3 minutes to finish.

If you want a steady flow of these, you can lock ${area} on that page so no other IT company gets it. No call needed. If you have a question, just reply here.

${firstWord(senderName())}`;
}
function footerWhy(p) {
  return `You received this because ${clip(p.company, 120) || 'your company'} is an IT company${p.area ? ' in ' + clip(p.area, 120) : ''}, and we find local clients for IT companies.`;
}
function withFooter(p, text) { return canSpam.appendText(text, p.email, { why: footerWhy(p) }); }

// ── IMPORT, APPROVE, REMOVE ─────────────────────────────────────────────────
// rows: [{ email, first, last, company, area, subject, body, fu1, fu2 }] or,
// instead of subject and body, { picks: [...], checked, withGap } to compose.
// Skipped: a bad address, one already on the list, a second person at the
// same company, a paying customer's company, the suppression list.
async function importRows(pool, rows, opts = {}) {
  await ensureTables(pool);
  const list = (Array.isArray(rows) ? rows : []).slice(0, 500);
  const approve = !!opts.approve || AUTOSEND();
  const out = { added: 0, queued: 0, skipped: [] };
  const custDomains = new Set();
  try {
    const c = await pool.query(`SELECT email FROM prospector_customers WHERE email IS NOT NULL`);
    for (const r of c.rows) { const d = domainOf(r.email); if (d) custDomains.add(d); }
  } catch (_) { /* no customers table yet */ }
  for (const row of list) {
    const email = lc(row && (row.email || row.to));
    const skip = (why) => out.skipped.push({ email: email || null, company: clip(row && row.company, 120) || null, why });
    if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(email)) { skip('not an email address'); continue; }
    const dom = domainOf(email);
    let subject = clip(row.subject, 200), body = String(row.body || '').trim().slice(0, 6000);
    if (!subject || !body) {
      const made = compose(row);
      if (!made) { skip('no subject and body, and no businesses to write about'); continue; }
      subject = made.subject; body = made.body;
    }
    if (custDomains.has(dom)) { skip('already a customer'); continue; }
    const sup = await suppression.isSuppressed(pool, email);
    if (sup.suppressed) { skip(sup.reason || 'on the suppression list'); continue; }
    const dup = await pool.query(`SELECT email FROM prospector_outreach WHERE email = $1 OR domain = $2 LIMIT 1`, [email, dom]);
    if (dup.rows[0]) { skip(dup.rows[0].email === email ? 'already on the list' : `someone at ${dom} is already on the list`); continue; }
    const r = await pool.query(`INSERT INTO prospector_outreach (email, domain, first_name, last_name, company, area, subject, body, fu1, fu2,
        source, batch, state, approved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (email) DO NOTHING RETURNING id`,
    [email, dom, clip(row.first || row.first_name, 60) || null, clip(row.last || row.last_name, 60) || null, clip(row.company, 160) || null,
      clip(row.area || row.city, 120) || null, subject, body, String(row.fu1 || '').trim().slice(0, 3000) || null,
      String(row.fu2 || '').trim().slice(0, 3000) || null, clip(opts.source || row.source, 40) || 'import', clip(opts.batch || row.batch, 80) || null,
      approve ? 'queued' : 'draft', approve ? new Date() : null]);
    if (!r.rows[0]) { skip('already on the list'); continue; }
    out.added++; if (approve) out.queued++;
    await event(pool, r.rows[0].id, approve ? 'approved' : 'imported', { detail: approve ? (opts.approve ? 'approved on import' : 'PROSPECTOR_AUTOSEND_ON') : null });
  }
  return out;
}
// JohnMark's OK: drafts to queued. { ids: [...] } or { batch } or { all: true }.
async function approve(pool, sel = {}) {
  await ensureTables(pool);
  let r;
  if (Array.isArray(sel.ids) && sel.ids.length) {
    r = await pool.query(`UPDATE prospector_outreach SET state = 'queued', approved_at = NOW(), updated_at = NOW()
      WHERE state = 'draft' AND id = ANY($1::int[]) RETURNING id`, [sel.ids.map(Number).filter(Number.isFinite)]);
  } else if (sel.batch) {
    r = await pool.query(`UPDATE prospector_outreach SET state = 'queued', approved_at = NOW(), updated_at = NOW()
      WHERE state = 'draft' AND batch = $1 RETURNING id`, [clip(sel.batch, 80)]);
  } else if (sel.all === true) {
    r = await pool.query(`UPDATE prospector_outreach SET state = 'queued', approved_at = NOW(), updated_at = NOW() WHERE state = 'draft' RETURNING id`);
  } else {
    throw Object.assign(new Error('Say which: ids, batch, or all: true.'), { status: 400 });
  }
  for (const row of r.rows) await event(pool, row.id, 'approved', { detail: sel.by || 'admin' });
  return { approved: r.rowCount };
}
async function stop(pool, id, reason, kind = 'stopped', at = null) {
  await pool.query(`UPDATE prospector_outreach SET state = 'stopped', stop_reason = $2, next_at = NULL, sending_at = NULL, updated_at = NOW()
    WHERE id = $1 AND state NOT IN ('stopped')`, [id, clip(reason, 300)]);
  await event(pool, id, kind, { detail: reason, at });
}
async function remove(pool, ids) {
  await ensureTables(pool);
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isFinite);
  for (const id of list) await stop(pool, id, 'removed by admin');
  return { removed: list.length };
}
async function pause(pool, reason) {
  await ensureTables(pool);
  await pool.query(`UPDATE prospector_outreach_state SET paused = TRUE, paused_reason = $1, paused_at = NOW(), updated_at = NOW() WHERE id = 1`, [clip(reason, 500)]);
  await event(pool, null, 'paused', { detail: reason });
}
async function resume(pool) {
  await ensureTables(pool);
  await pool.query(`UPDATE prospector_outreach_state SET paused = FALSE, paused_reason = NULL, updated_at = NOW() WHERE id = 1`);
  await event(pool, null, 'resumed');
}

// ── THE MAILBOXES ───────────────────────────────────────────────────────────
// Warm-up per mailbox: day 1 is the first Central date it sent anything.
async function capFor(pool, addr, today) {
  const r = (await pool.query(`SELECT
      COUNT(DISTINCT (at AT TIME ZONE '${CENTRAL}')::date) FILTER (WHERE (at AT TIME ZONE '${CENTRAL}')::date < $2::date)::int AS before,
      COUNT(*) FILTER (WHERE (at AT TIME ZONE '${CENTRAL}')::date = $2::date)::int AS today,
      MAX(at) AS last
    FROM prospector_outreach_events WHERE kind = 'sent' AND mailbox = $1`, [addr, today])).rows[0] || {};
  const before = r.before || 0;
  return { day: before + 1, cap: Math.min(DAILY_CAP(), WARMUP_START() + WARMUP_STEP() * before), sentToday: r.today || 0, last: r.last || null };
}
async function mailboxStatus(pool, now, deps = {}) {
  const st = await getState(pool);
  const today = central(now).date;
  const out = [];
  for (const addr of mailboxes()) {
    let acct;
    try { acct = deps.account ? await deps.account(addr) : await MB.account(pool, addr); }
    catch (e) { acct = { ok: false, address: addr, why: e.message }; }
    const cap = await capFor(pool, addr, today);
    const limited = st.limited[addr] === today;
    const gapOk = !cap.last || (new Date(now) - new Date(cap.last)) >= GAP_MS();
    out.push({ address: addr, acct, ...cap, limited, gapOk,
      free: !!(acct && acct.ok && acct.canSend) && !limited && cap.sentToday < cap.cap && gapOk });
  }
  return out;
}
async function markLimited(pool, addr, today, why, deps = {}) {
  const st = await getState(pool);
  const limited = { ...st.limited, [addr]: today };
  await pool.query(`UPDATE prospector_outreach_state SET limited = $1, updated_at = NOW() WHERE id = 1`, [JSON.stringify(limited)]);
  await event(pool, null, 'limited', { mailbox: addr, detail: why });
  await tell({ subject: `Prospector: Microsoft limited ${addr} for today`,
    text: `${addr} stopped sending for the rest of today because Microsoft limited it:\n\n${why}\n\nIt starts again tomorrow by itself. If this happens two days in a row, lower PROSPECTOR_DAILY_CAP.` }, deps);
}
async function tell(msg, deps = {}) {
  try {
    if (deps.alert) return await deps.alert(msg);
    return await require('../salesAutopilot').alert(msg);
  } catch (e) { console.error('[prospector-outreach] alert failed:', e.message); return null; }
}
function mail(deps) { return deps.mail || MB; }

// ── SENDING ─────────────────────────────────────────────────────────────────
// One tick: at most one email per free mailbox. Follow-ups first (they are
// owed), then new first emails, oldest approval first.
async function sendTick(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  if (!ON() && !deps.force) return { skipped: 'PROSPECTOR_OUTREACH_ON is off' };
  const st = await getState(pool);
  if (st.paused) return { skipped: 'paused: ' + (st.paused_reason || '') };
  const w = inWindow(now);
  if (!w.ok) return { skipped: w.why };
  if (!canSpam.configured()) return { skipped: canSpam.problem() };
  if (!mailboxes().length) return { skipped: 'PROSPECTOR_FROM_ADDRESS is not set' };
  const boxes = await mailboxStatus(pool, now, deps);
  const free = new Map(boxes.filter((b) => b.free).map((b) => [b.address, b]));
  if (!free.size) return { skipped: 'no mailbox free right now', mailboxes: boxes.map((b) => ({ address: b.address, why: b.acct && !b.acct.ok ? b.acct.why : null, sentToday: b.sentToday, cap: b.cap, limited: b.limited })) };
  const sent = [];
  const due = (await pool.query(`SELECT * FROM prospector_outreach WHERE state = 'active' AND next_at <= $1
      AND (sending_at IS NULL OR sending_at < $1::timestamptz - INTERVAL '10 minutes') ORDER BY next_at LIMIT 50`, [now])).rows;
  for (const p of due) {
    if (!free.has(p.mailbox)) continue;
    const r = await sendOne(pool, p, free.get(p.mailbox), { now, deps, today: w.today });
    sent.push(r); free.delete(p.mailbox);
    if (!free.size) break;
  }
  while (free.size) {
    const p = (await pool.query(`SELECT * FROM prospector_outreach WHERE state = 'queued'
        AND (sending_at IS NULL OR sending_at < $1::timestamptz - INTERVAL '10 minutes') ORDER BY approved_at NULLS LAST, id LIMIT 1`, [now])).rows[0];
    if (!p) break;
    // The mailbox with the fewest sent today.
    const box = [...free.values()].sort((a, b) => a.sentToday - b.sentToday)[0];
    const r = await sendOne(pool, p, box, { now, deps, today: w.today });
    sent.push(r); free.delete(box.address);
  }
  return { sent };
}

async function sendOne(pool, p, box, { now = new Date(), deps = {}, today } = {}) {
  // Claimed, so two ticks never send the same step twice.
  const claim = await pool.query(`UPDATE prospector_outreach SET sending_at = $2, updated_at = NOW()
    WHERE id = $1 AND state = $3 AND step = $4 AND (sending_at IS NULL OR sending_at < $2::timestamptz - INTERVAL '10 minutes') RETURNING id`,
  [p.id, now, p.state, p.step]);
  if (!claim.rowCount) return { id: p.id, skipped: 'taken by another tick' };
  const release = () => pool.query(`UPDATE prospector_outreach SET sending_at = NULL WHERE id = $1`, [p.id]);
  const sup = await suppression.isSuppressed(pool, p.email);
  if (sup.suppressed) { await stop(pool, p.id, sup.reason || 'on the suppression list', 'suppressed'); return { id: p.id, skipped: 'suppressed' }; }
  const mb = box.acct;
  const M = mail(deps);
  const step = p.step + 1;
  try {
    if (step === 1) {
      const r = await M.sendNew(mb, { to: p.email, subject: p.subject, text: withFooter(p, p.body) }, deps.graphDeps || {});
      const first = new Date(now);
      await pool.query(`UPDATE prospector_outreach SET state = 'active', step = 1, mailbox = $2, message_id = $3, conversation_id = $4,
          first_sent_at = $5, last_sent_at = $5, next_at = $6, sending_at = NULL, errors = 0, last_error = NULL, updated_at = NOW() WHERE id = $1`,
      [p.id, box.address, r.messageId || null, r.conversationId || null, first, new Date(first.getTime() + FOLLOW_UP_DAYS[0] * 86400000)]);
    } else {
      let messageId = p.message_id;
      if (!messageId) {
        const found = await M.findSent(mb, { to: p.email, subject: p.subject, since: new Date(new Date(p.first_sent_at || now).getTime() - 3600000) }, deps.graphDeps || {}).catch(() => null);
        if (found) {
          messageId = found.messageId;
          await pool.query(`UPDATE prospector_outreach SET message_id = $2, conversation_id = COALESCE(conversation_id, $3) WHERE id = $1`, [p.id, found.messageId, found.conversationId]);
        }
      }
      const text = withFooter(p, String(step === 2 ? p.fu1 || '' : p.fu2 || '').trim() || followUp(p, step - 1));
      if (messageId) await M.reply(mb, { messageId, to: p.email, text }, deps.graphDeps || {});
      else await M.sendNew(mb, { to: p.email, subject: 'Re: ' + p.subject, text }, deps.graphDeps || {});
      const last = step === 1 + FOLLOW_UP_DAYS.length;
      const next = last ? null : new Date(new Date(p.first_sent_at || now).getTime() + FOLLOW_UP_DAYS[step - 1] * 86400000);
      await pool.query(`UPDATE prospector_outreach SET step = $2, state = $3, last_sent_at = $4, next_at = $5, sending_at = NULL, errors = 0,
          last_error = NULL, updated_at = NOW() WHERE id = $1`, [p.id, step, last ? 'done' : 'active', now, next]);
    }
    await event(pool, p.id, 'sent', { step, mailbox: box.address, at: now });
    return { id: p.id, email: p.email, step, mailbox: box.address };
  } catch (e) {
    await release();
    if (MB.isSendLimit(e)) {
      await markLimited(pool, box.address, today || central(now).date, e.message, deps);
      return { id: p.id, error: 'mailbox limited', mailbox: box.address };
    }
    const errors = (p.errors || 0) + 1;
    await pool.query(`UPDATE prospector_outreach SET errors = $2, last_error = $3, next_at = CASE WHEN state = 'active' THEN $4::timestamptz ELSE next_at END,
      updated_at = NOW() WHERE id = $1`, [p.id, errors, clip(e.message, 300), new Date(new Date(now).getTime() + 3600000)]);
    await event(pool, p.id, 'error', { step, mailbox: box.address, detail: e.message });
    if (errors >= MAX_ERRORS) await stop(pool, p.id, `${MAX_ERRORS} send errors in a row: ${clip(e.message, 200)}`);
    else if (p.state === 'queued') {
      // Back of the queue for an hour, so one bad address does not block the rest.
      await pool.query(`UPDATE prospector_outreach SET approved_at = $2 WHERE id = $1`, [p.id, new Date(new Date(now).getTime() + 3600000)]);
    }
    return { id: p.id, error: e.message };
  }
}

// ── REPLIES ─────────────────────────────────────────────────────────────────
const YES = /^\s*(yes|yep|yeah|sure|ok(ay)?|please|go ahead|send( (them|it|me|those|it over|them over))?|i'?d like (them|that|to see)|absolutely|definitely)\b/i;

// Every Prospector mailbox, since its cursor: bounces stop the address,
// replies stop the sequence, an interested reply gets its sample.
async function scanReplies(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  if (!ON() && !deps.force) return { skipped: 'PROSPECTOR_OUTREACH_ON is off' };
  const st = await getState(pool);
  const cursors = { ...st.cursors };
  const M = mail(deps);
  const report = { mailboxes: [], replies: 0, bounces: 0, answered: 0 };
  for (const addr of mailboxes()) {
    let mb;
    try { mb = deps.account ? await deps.account(addr) : await MB.account(pool, addr); } catch (e) { mb = { ok: false, why: e.message }; }
    if (!mb || !mb.ok || !mb.canRead) { report.mailboxes.push({ address: addr, skipped: (mb && mb.why) || 'cannot read this mailbox' }); continue; }
    const since = cursors[addr] ? new Date(cursors[addr]) : new Date(new Date(now).getTime() - 2 * 86400000);
    let msgs;
    try { msgs = await M.inboxSince(mb, since, deps.graphDeps || {}); }
    catch (e) { report.mailboxes.push({ address: addr, error: e.message }); continue; }
    let folderId = null;
    let latest = since;
    for (const m of msgs) {
      const at = new Date(m.receivedDateTime || now);
      if (at > latest) latest = at;
      try {
        const r = await onMessage(pool, mb, addr, m, { now, deps });
        if (r === 'reply' || r === 'answered') report.replies++;
        if (r === 'answered') report.answered++;
        if (r === 'bounce') report.bounces++;
        if ((r === 'reply' || r === 'answered') && mb.canMove) {
          try { folderId = folderId || await M.ensureFolder(mb, deps.graphDeps || {}, FOLDER); await M.move(mb, m.id, folderId, deps.graphDeps || {}); }
          catch (_) { /* filing is a nicety */ }
        }
      } catch (e) { console.error('[prospector-outreach] message:', e.message); }
    }
    // One second past the newest seen, so the same message is not read twice.
    cursors[addr] = new Date(latest.getTime() + 1000).toISOString();
    report.mailboxes.push({ address: addr, read: msgs.length });
  }
  await pool.query(`UPDATE prospector_outreach_state SET cursors = $1, updated_at = NOW() WHERE id = 1`, [JSON.stringify(cursors)]);
  const b = await bounceCheck(pool, { now, deps });
  if (b.paused) report.paused = b.reason;
  return report;
}

async function onMessage(pool, mb, addr, m, { now, deps }) {
  const M = mail(deps);
  const text = (M.textOf || MB.textOf)(m);
  const from = (M.fromOf || MB.fromOf)(m);
  if (SR.isMicrosoftWarning(m, text)) {
    await markLimited(pool, addr, central(now).date, clip(m.subject, 200), deps);
    return 'warning';
  }
  if (SR.isBounce(m)) {
    if (SR.NDR_LIMIT.test(text)) { await markLimited(pool, addr, central(now).date, (text.match(SR.NDR_LIMIT) || [''])[0], deps); return 'warning'; }
    // Whose address bounced: one of ours named in the report.
    const emails = [...new Set((text.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).map(lc))].filter((e) => e !== lc(addr));
    if (!emails.length) return 'ignored';
    const hit = (await pool.query(`SELECT * FROM prospector_outreach WHERE email = ANY($1::text[]) AND step > 0 LIMIT 1`, [emails])).rows[0];
    if (!hit) return 'ignored';
    await suppression.suppress(pool, hit.email, { reason: 'Prospector outreach bounced', kind: 'bounce' });
    await stop(pool, hit.id, 'bounced', 'bounce', now);
    return 'bounce';
  }
  let p = (await pool.query(`SELECT * FROM prospector_outreach WHERE email = $1 AND step > 0`, [from])).rows[0];
  if (!p && m.conversationId) p = (await pool.query(`SELECT * FROM prospector_outreach WHERE conversation_id = $1`, [m.conversationId])).rows[0];
  if (!p) return 'ignored';
  if (SR.isAutoReply(m)) { await event(pool, p.id, 'auto-reply', { mailbox: addr, detail: clip(m.subject, 200) }); return 'auto'; }
  const own = SR.ownWords(text) || text;
  const c = await SR.classify(text, { email: p.email }, deps.classifyDeps || deps);
  const tag = YES.test(own) && c.tag !== 'unsubscribe' ? 'interested' : c.tag;
  await pool.query(`UPDATE prospector_outreach SET state = CASE WHEN state = 'stopped' THEN state ELSE 'replied' END, reply_tag = $2, replied_at = $3,
      reply_text = $4, next_at = NULL, updated_at = NOW() WHERE id = $1`, [p.id, tag, m.receivedDateTime || now, clip(own, 2000)]);
  await event(pool, p.id, 'reply', { mailbox: addr, detail: `${tag}: ${clip(own, 400)}` });
  const who = `${[p.first_name, p.last_name].filter(Boolean).join(' ') || p.email} (${p.company || p.domain}, ${p.area || 'no area'})`;
  if (tag === 'unsubscribe') {
    await suppression.suppress(pool, p.email, { reason: c.complaint ? 'complained about Prospector outreach' : 'asked to stop (Prospector outreach)', kind: c.complaint ? 'complaint' : 'unsubscribe' });
    await stop(pool, p.id, c.complaint ? 'complained' : 'asked to stop', 'unsubscribe');
    if (c.complaint) await tell({ subject: `Prospector: a complaint from ${p.email}`, text: `${who} complained:\n\n${clip(own, 1500)}\n\nThey are on the suppression list and will never be emailed again.` }, deps);
    return 'reply';
  }
  if (tag !== 'interested') {
    await tell({ subject: `Prospector reply (${tag}): ${p.company || p.email}`, text: `${who} replied (${tag}):\n\n${clip(own, 1500)}\n\nTheir emails have stopped. Nothing else was sent.` }, deps);
    return 'reply';
  }
  return answer(pool, mb, addr, p, m, { now, deps, own });
}

// The sample, built and linked. Sent back only with PROSPECTOR_AUTOSEND_ON;
// otherwise JohnMark gets the link and the words to send.
async function answer(pool, mb, addr, p, m, { now, deps, own }) {
  const M = mail(deps);
  let token = p.sample_token;
  if (!token) {
    try {
      const S = require('./samples');
      const r = await (deps.createSample || S.create)(pool, { company: p.company || p.domain, first: p.first_name, last: p.last_name,
        email: p.email, area: p.area, source: 'outreach' }, deps.sampleDeps || {});
      token = r.token;
      await pool.query(`UPDATE prospector_outreach SET sample_token = $2 WHERE id = $1`, [p.id, token]);
    } catch (e) {
      await event(pool, p.id, 'error', { detail: 'sample: ' + e.message });
    }
  }
  const link = token ? `${appUrl()}/s/${token}` : null;
  const words = link ? answerText(p, link) : null;
  let answered = false;
  if (words && AUTOSEND() && !p.answered_at && mb.canSend) {
    try {
      await M.reply(mb, { messageId: m.id, to: p.email, text: words }, deps.graphDeps || {});
      await pool.query(`UPDATE prospector_outreach SET answered_at = $2 WHERE id = $1`, [p.id, now]);
      await event(pool, p.id, 'answered', { mailbox: addr, detail: link });
      answered = true;
    } catch (e) { await event(pool, p.id, 'error', { mailbox: addr, detail: 'answer: ' + e.message }); }
  }
  const who = `${[p.first_name, p.last_name].filter(Boolean).join(' ') || p.email} (${p.company || p.domain}, ${p.area || 'no area'})`;
  await tell({ subject: `Prospector: ${p.company || p.email} is interested`,
    text: `${who} replied:\n\n${clip(own, 1500)}\n\n`
      + (answered ? `Their free sample was sent back automatically: ${link}\n\nIf they buy on that page, you'll get the Stripe email. Nothing else to do.`
        : link ? `Their sample is building: ${link}\n\nAuto-answer is off (PROSPECTOR_AUTOSEND_ON), so reply from ${addr} with:\n\n${words}`
          : `Their sample could not be started. Reply to them from ${addr}.`) }, deps);
  return answered ? 'answered' : 'reply';
}

// Over 2% of the last 14 days' first emails bounced, with at least 20 sent:
// everything stops until JohnMark resumes it.
async function bounceCheck(pool, { now = new Date(), deps = {} } = {}) {
  const since = new Date(new Date(now).getTime() - BOUNCE_DAYS * 86400000);
  const r = (await pool.query(`SELECT COUNT(*) FILTER (WHERE kind = 'sent' AND step = 1)::int AS sent,
      COUNT(*) FILTER (WHERE kind = 'bounce')::int AS bounces FROM prospector_outreach_events WHERE at >= $1`, [since])).rows[0];
  const st = await getState(pool);
  if (st.paused || r.sent < BOUNCE_MIN_SENDS || r.bounces / r.sent <= BOUNCE_LIMIT) return { paused: false, sent: r.sent, bounces: r.bounces };
  const reason = `${r.bounces} of ${r.sent} first emails bounced in ${BOUNCE_DAYS} days (over ${BOUNCE_LIMIT * 100}%)`;
  await pause(pool, reason);
  await tell({ subject: 'Prospector outreach paused: too many bounces', text: `${reason}. Sending stopped to protect the mailbox.\n\nThe list probably has stale addresses. Resume it from /lab/prospector once the list is cleaned.` }, deps);
  return { paused: true, reason, sent: r.sent, bounces: r.bounces };
}

// ── WHAT THE ADMIN SEES ─────────────────────────────────────────────────────
async function status(pool, { now = new Date(), deps = {} } = {}) {
  await ensureTables(pool);
  const st = await getState(pool);
  const counts = Object.fromEntries(STATES.map((s) => [s, 0]));
  for (const r of (await pool.query(`SELECT state, COUNT(*)::int AS n FROM prospector_outreach GROUP BY state`)).rows) counts[r.state] = r.n;
  const tags = {};
  for (const r of (await pool.query(`SELECT reply_tag, COUNT(*)::int AS n FROM prospector_outreach WHERE reply_tag IS NOT NULL GROUP BY reply_tag`)).rows) tags[r.reply_tag] = r.n;
  const ev = (await pool.query(`SELECT COUNT(*) FILTER (WHERE kind = 'sent')::int AS sent, COUNT(*) FILTER (WHERE kind = 'sent' AND step = 1)::int AS firsts,
      COUNT(*) FILTER (WHERE kind = 'bounce')::int AS bounces, COUNT(*) FILTER (WHERE kind = 'reply')::int AS replies,
      COUNT(*) FILTER (WHERE kind = 'answered')::int AS answered FROM prospector_outreach_events`)).rows[0];
  const boxes = mailboxes().length ? await mailboxStatus(pool, now, deps) : [];
  const problems = [];
  if (!ON()) problems.push('PROSPECTOR_OUTREACH_ON is off, so nothing is sent or read.');
  if (!mailboxes().length) problems.push('PROSPECTOR_FROM_ADDRESS is not set: the sales mailbox address(es), comma separated.');
  for (const b of boxes) if (!b.acct || !b.acct.ok) problems.push(b.acct ? b.acct.why : `${b.address} could not be checked.`);
    else if (!b.acct.canSend) problems.push(`${b.address} is connected without permission to send. Reconnect it.`);
  if (!canSpam.configured()) problems.push(canSpam.problem());
  if (st.paused) problems.push('Paused: ' + (st.paused_reason || 'by admin'));
  return {
    on: ON(), autosend: AUTOSEND(), paused: !!st.paused, pausedReason: st.paused_reason || null, window: inWindow(now),
    counts, tags, totals: ev, problems,
    mailboxes: boxes.map((b) => ({ address: b.address, connected: !!(b.acct && b.acct.ok), canSend: !!(b.acct && b.acct.canSend),
      canRead: !!(b.acct && b.acct.canRead), canMove: !!(b.acct && b.acct.canMove), warmupDay: b.day, capToday: b.cap,
      sentToday: b.sentToday, limitedToday: b.limited, lastSent: b.last,
      connectUrl: '/admin/prospector/connect-mailbox?address=' + encodeURIComponent(b.address) })),
  };
}
async function list(pool, { state, limit = 200 } = {}) {
  await ensureTables(pool);
  const args = [Math.min(Math.max(Number(limit) || 200, 1), 1000)];
  let where = '';
  if (state && STATES.includes(state)) { where = 'WHERE state = $2'; args.push(state); }
  const r = await pool.query(`SELECT id, email, first_name, last_name, company, area, subject, body, state, step, mailbox, next_at, first_sent_at,
      last_sent_at, reply_tag, replied_at, reply_text, sample_token, answered_at, stop_reason, batch, last_error, created_at
    FROM prospector_outreach ${where} ORDER BY COALESCE(replied_at, last_sent_at, created_at) DESC LIMIT $1`, args);
  return r.rows;
}

// ── THE CLOCK ───────────────────────────────────────────────────────────────
// Every minute: one send per free mailbox. Every 5 minutes: the inboxes.
// Idle (one cheap check) while PROSPECTOR_OUTREACH_ON is off.
let _timer = null, _busy = false, _ticks = 0;
function start(pool) {
  if (_timer) return;
  _timer = setInterval(async () => {
    if (_busy || !ON()) return;
    _busy = true;
    try {
      if (_ticks++ % 5 === 0) await scanReplies(pool).catch((e) => console.error('[prospector-outreach] scan:', e.message));
      await sendTick(pool).catch((e) => console.error('[prospector-outreach] send:', e.message));
    } finally { _busy = false; }
  }, 60 * 1000);
  if (_timer.unref) _timer.unref();
}
function stopClock() { if (_timer) clearInterval(_timer); _timer = null; }

module.exports = {
  ON, AUTOSEND, mailboxes, ensureTables, getState, compose, followUp, answerText, footerWhy, importRows, approve, remove, pause, resume,
  capFor, mailboxStatus, sendTick, sendOne, scanReplies, onMessage, bounceCheck, status, list, start, stopClock, inWindow, central,
  YES, FOLLOW_UP_DAYS, FOLDER, _reset() { _ensured = false; },
};
