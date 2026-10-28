'use strict';
// ── DONE FOR YOU: THE MORNING'S PITCHES GO OUT WITHOUT A LOGIN ─────────────
//
// WHY. As of Oct 27 2026, July to October: 4,006 businesses found for agents,
// 59 contacted, 2 replies, no signed deal. The engine fills five cards per
// athlete most nights; the cards wait for an agent who does not come (11 of 18
// accounts dormant). Nobody keeps paying for a tool that has not produced a
// reply. So an agent can say once "send my pitches every morning", from
// Settings or from a one-tap link in the nightly email, and NILDash approves
// that morning's email batch for them.
//
// HOW IT SENDS. Exactly the way the agent's own "approve all" does: the
// Closer's batch (services/closer buildBatch: the allocator, the daily
// ceiling, suppressed and missing addresses already dropped) is approved with
// approveBatch, and jobs/closerRelease sends each email from the agent's own
// mailbox with every send-time check unchanged (the send gate, a reply first,
// suppression, the compliance gate, the 4-day rule, duplicate subjects).
// Nothing here talks to a mailbox.
//
// WHEN. Weekdays, once a day per agent, from AUTO_SEND_AT (9:00 Central) to
// 3:00 Central. A claim row (auto_send_runs) makes it once, across restarts
// and instances.
//
// WHAT THE AGENT HEARS. One short email, AFTER the release queue has worked
// through the batch, naming only what actually went out (sent_at set) and
// saying how many were held back by a send-time check. Never "sent" for an
// email that was approved and then stopped. Replies come to their own inbox.
//
// THE SWITCHES. AUTO_SEND_ON=true turns the job on at all (off: nothing here
// runs, Settings hides the card, the digest offers nothing). Per agent,
// users.auto_send_on; turning it on needs a connected mailbox and a business
// address (or a past send, services/canSpam.senderAddress), and says which is
// missing. Checked again every morning before anything is approved.

const crypto = require('crypto');
const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const ON = () => truthy(process.env.AUTO_SEND_ON);
const intEnv = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) ? n : d; };
const SEND_AT = () => intEnv('AUTO_SEND_AT', 9 * 60);       // Central minutes
const SEND_UNTIL = 15 * 60;
const NOTE_AFTER_MS = 12 * 3600 * 1000;                     // note goes anyway after this, naming what is still sending
const MAX_AGE_DAYS = 14;                                     // a draft older than this is not "this morning's" pitch
const CENTRAL = 'America/Chicago';
const APP_URL = () => (process.env.APP_URL || 'https://mynildash.com').replace(/\/+$/, '');

let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_send_on BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_send_since TIMESTAMPTZ`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_send_token TEXT`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_send_invited_at TIMESTAMPTZ`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auto_send_runs (
      agent_id TEXT NOT NULL, run_date DATE NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
      approved INTEGER NOT NULL DEFAULT 0, offered INTEGER NOT NULL DEFAULT 0, note TEXT, detail JSONB,
      note_at TIMESTAMPTZ, sent INTEGER, held INTEGER, emailed_at TIMESTAMPTZ,
      PRIMARY KEY (agent_id, run_date))`);
  })().catch((e) => { _ready = null; throw e; });
  return _ready;
}

function central(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: CENTRAL, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(now ? new Date(now) : new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute), weekday: p.weekday };
}

// What Settings shows. -> { available, on, since, ready, missing: [..], last }
async function status(pool, agentId, deps = {}) {
  await ensureTables(pool);
  const u = (await pool.query(`SELECT auto_send_on, auto_send_since FROM users WHERE id = $1`, [agentId])).rows[0] || {};
  const missing = await missingFor(pool, agentId, deps);
  const last = (await pool.query(`SELECT run_date::text AS date, approved, sent, held, note FROM auto_send_runs WHERE agent_id = $1 ORDER BY run_date DESC LIMIT 1`, [agentId])).rows[0] || null;
  return { available: ON(), on: !!u.auto_send_on, since: u.auto_send_since || null, ready: !missing.length, missing, last, sendsAt: '9:00 am Central, weekdays' };
}

const MISSING_MAILBOX = 'connect the mailbox your pitches send from (Settings, Email)';
const MISSING_ADDRESS = 'add your business address (Settings, the first box)';
// What must be in place before NILDash sends for an agent.
async function missingFor(pool, agentId, deps = {}) {
  const out = [];
  try {
    const mb = deps.mailbox ? await deps.mailbox(agentId) : await require('./emailStore').sendingMailbox(agentId);
    if (!mb || !mb.connected) out.push(MISSING_MAILBOX);
  } catch (_) { out.push(MISSING_MAILBOX); }
  try {
    const sa = deps.senderAddress ? await deps.senderAddress(agentId) : await require('./canSpam').senderAddress(pool, agentId);
    if (!sa || !sa.ok) out.push(MISSING_ADDRESS);
  } catch (_) { out.push(MISSING_ADDRESS); }
  return out;
}

// Settings' switch, and the one-tap page's. -> { ok, on, missing?, error? }
async function set(pool, agentId, on, deps = {}) {
  await ensureTables(pool);
  if (on) {
    if (!ON()) return { ok: false, error: 'Automatic sending is not available yet.' };
    const missing = await missingFor(pool, agentId, deps);
    if (missing.length) return { ok: false, missing, error: 'Before NILDash can send for you: ' + missing.join('; ') + '.' };
    await pool.query(`UPDATE users SET auto_send_on = TRUE, auto_send_since = COALESCE(auto_send_since, NOW()) WHERE id = $1`, [agentId]);
  } else {
    // The old one-tap link stops working: a forwarded or months-old email
    // cannot switch it back on. The next nightly email carries a new one.
    await pool.query(`UPDATE users SET auto_send_on = FALSE, auto_send_since = NULL, auto_send_token = NULL WHERE id = $1`, [agentId]);
  }
  return { ok: true, on: !!on };
}

// ── THE ONE-TAP LINK ────────────────────────────────────────────────────────
// For the agent who never logs in: the nightly email carries it. The link
// opens a page with one button; the GET changes nothing, so a mail scanner
// that follows every link cannot turn it on. One token per agent, kept.
async function tokenFor(pool, agentId) {
  await ensureTables(pool);
  const t = crypto.randomBytes(24).toString('hex');
  await pool.query(`UPDATE users SET auto_send_token = $2 WHERE id = $1 AND auto_send_token IS NULL`, [agentId, t]);
  const r = (await pool.query(`SELECT auto_send_token FROM users WHERE id = $1`, [agentId])).rows[0];
  return (r && r.auto_send_token) || null;
}
// The link to offer, or null (off, or already on).
async function offerUrl(pool, agentId) {
  if (!ON()) return null;
  await ensureTables(pool);
  const u = (await pool.query(`SELECT auto_send_on FROM users WHERE id = $1`, [agentId])).rows[0];
  if (!u || u.auto_send_on) return null;
  const t = await tokenFor(pool, agentId);
  return t ? `${APP_URL()}/auto-send/on?t=${encodeURIComponent(t)}` : null;
}
// The one-tap "stop automatic sending" link for the morning note, or null.
async function offUrlFor(pool, agentId) {
  await ensureTables(pool);
  const u = (await pool.query(`SELECT auto_send_on FROM users WHERE id = $1`, [agentId])).rows[0];
  if (!u || !u.auto_send_on) return null;
  const t = await tokenFor(pool, agentId);
  return t ? `${APP_URL()}/auto-send/off?t=${encodeURIComponent(t)}` : null;
}
async function byToken(pool, token) {
  const t = String(token || '').trim();
  if (!/^[a-f0-9]{48}$/.test(t)) return null;
  await ensureTables(pool);
  return (await pool.query(`SELECT id, name, email, sign_first_name, auto_send_on FROM users WHERE auto_send_token = $1 AND archived IS NOT TRUE`, [t])).rows[0] || null;
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
// "ASANTE BRADFORD" reads as shouting: an all-caps name is written Asante.
// Any other capitals stay as typed ("JohnMark").
const firstOf = (u) => {
  const f = String((u && (u.sign_first_name || u.name)) || '').trim().split(/\s+/)[0] || 'there';
  return f.length > 1 && f === f.toUpperCase() && /[A-Z]/.test(f) ? f[0] + f.slice(1).toLowerCase() : f;
};

// The one-tap page. state: 'ask' | 'on' | 'already' | 'missing' | 'off' | 'bad'
function page(state, { user, token, missing } = {}) {
  const body = {
    ask: `<h1>Send your pitches every morning?</h1>
      <p>Every weekday at 9:00 am Central, NILDash sends that morning's email pitches for your athletes from your own mailbox. You don't need to log in.</p>
      <p>Every email still passes the same checks as when you approve it yourself: verified addresses only, unsubscribes respected, and no follow-up after a business replies.</p>
      <p>Right before each pitch goes out, NILDash checks it is still right. If an athlete changed schools or positions, or a pitch looks weak, it waits for you instead.</p>
      <p>You get one short email listing what went out. Replies come straight to your inbox. It is optional: turn it off any time with one tap from that email, or in Settings.</p>
      <form method="post" action="/auto-send/on"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Yes, send my pitches every morning</button></form>`,
    offask: `<h1>Turn off automatic sending?</h1><p>Your pitches will wait for you to approve them, like before. You can turn it back on any time in Settings.</p>
      <form method="post" action="/auto-send/off"><input type="hidden" name="t" value="${esc(token)}"><button type="submit">Turn it off</button></form>`,
    offdone: `<h1>Automatic sending is off.</h1><p>Your pitches will wait for you to approve them. Turn it back on any time in Settings.</p>`,
    alreadyoff: `<h1>It's already off.</h1><p>Your pitches wait for you to approve them. Turn it back on any time in Settings.</p>`,
    on: `<h1>You're set, ${esc(firstOf(user))}.</h1><p>Your pitches go out every weekday at 9:00 am Central. You'll get a short email after each morning's send. Turn it off any time in Settings.</p>`,
    already: `<h1>It's already on.</h1><p>Your pitches go out every weekday at 9:00 am Central. Turn it off any time in Settings.</p>`,
    missing: `<h1>One thing first</h1><p>Before NILDash can send for you: ${esc((missing || []).join('; '))}.</p><p><a href="${esc(APP_URL())}/">Open NILDash</a>, then come back to this link.</p>`,
    off: `<h1>Not available yet</h1><p>Automatic sending isn't turned on yet. Your pitches are waiting in NILDash.</p>`,
    bad: `<h1>This link doesn't work</h1><p>Open NILDash and turn on "Send my pitches every morning" in Settings.</p>`,
  }[state] || '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">
<title>NILDash</title><style>body{margin:0;background:#f6f6f4;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#111827}
main{max-width:520px;margin:40px auto;background:#fff;border-radius:10px;padding:28px 24px}h1{font-size:22px;margin:0 0 14px}p{font-size:15px;line-height:1.55;color:#374151}
button{background:#111827;color:#fff;border:0;border-radius:8px;padding:12px 20px;font-size:15px;font-weight:600;cursor:pointer;width:100%}a{color:#111827}</style></head>
<body><main>${body}</main></body></html>`;
}

// ── THE MORNING NOTE ────────────────────────────────────────────────────────
// sent: [{ athleteName, brand, to }]; held: how many a send-time check stopped
// for good; still: how many are still waiting to go when the note is written.
function noteFor(agent, sent, held = 0, still = 0, opts = {}) {
  const first = firstOf(agent);
  const waiting = (opts && Array.isArray(opts.waiting)) ? opts.waiting : [];
  const offUrl = (opts && opts.offUrl) || null;
  const byAthlete = new Map();
  for (const it of sent) {
    const k = it.athleteName || 'Your athlete';
    if (!byAthlete.has(k)) byAthlete.set(k, []);
    byAthlete.get(k).push(it);
  }
  const n = sent.length, w = waiting.length;
  const subject = n
    ? `NILDash sent ${n} pitch${n === 1 ? '' : 'es'} for your athletes this morning`
    : `${w} pitch${w === 1 ? '' : 'es'} need${w === 1 ? 's' : ''} a quick look before ${w === 1 ? 'it goes' : 'they go'} out`;
  const heldLine = [
    held > 0 ? `${held} more didn't go out because a send check stopped ${held === 1 ? 'it' : 'them'} (for example the business replied first, or the address couldn't be confirmed). Your Home page shows why.` : null,
    still > 0 ? `${still} ${still === 1 ? 'is' : 'are'} still waiting to send and will go out shortly.` : null,
  ].filter(Boolean).join(' ') || null;
  const waitIntro = w
    ? `${w} pitch${w === 1 ? '' : 'es'} did not send, because NILDash checks every pitch is still right before it goes out. ${w === 1 ? 'It is' : 'They are'} waiting in NILDash for you to look at:`
    : null;
  const offText = offUrl ? `Don't want NILDash sending for you? Turn automatic sending off here: ${offUrl}` : 'To stop automatic sending, turn it off in Settings.';
  const lines = [`Hi ${first},`, ''];
  if (n) {
    lines.push(`NILDash sent ${n} pitch${n === 1 ? '' : 'es'} from your mailbox this morning:`, '');
    for (const [ath, list] of byAthlete) {
      lines.push(`${ath}:`);
      for (const it of list) lines.push(`  - ${it.brand}${it.to ? ', to ' + it.to : ''}`);
      lines.push('');
    }
  }
  if (heldLine) lines.push(heldLine, '');
  if (waitIntro) {
    lines.push(waitIntro, '');
    for (const it of waiting) lines.push(`  - ${it.brand}${it.athleteName ? ' (' + it.athleteName + ')' : ''}: ${it.why}`);
    lines.push('');
  }
  lines.push(n ? 'Replies come straight to your inbox.' : 'Approve or edit them on your Home page.', offText, '', 'NILDash');
  const html = `<p>Hi ${esc(first)},</p>`
    + (n ? `<p>NILDash sent ${n} pitch${n === 1 ? '' : 'es'} from your mailbox this morning:</p>`
      + Array.from(byAthlete).map(([ath, list]) => `<p><b>${esc(ath)}</b></p><ul>${list.map((it) => `<li>${esc(it.brand)}${it.to ? ', to ' + esc(it.to) : ''}</li>`).join('')}</ul>`).join('') : '')
    + (heldLine ? `<p>${esc(heldLine)}</p>` : '')
    + (waitIntro ? `<p>${esc(waitIntro)}</p><ul>${waiting.map((it) => `<li>${esc(it.brand)}${it.athleteName ? ' (' + esc(it.athleteName) + ')' : ''}: ${esc(it.why)}</li>`).join('')}</ul>` : '')
    + `<p>${n ? 'Replies come straight to your inbox.' : 'Approve or edit them on your Home page.'}</p>`
    + (offUrl ? `<p style="color:#6b7280;font-size:13px">Don't want NILDash sending for you? <a href="${esc(offUrl)}">Turn automatic sending off</a>.</p>` : `<p>To stop automatic sending, turn it off in Settings.</p>`)
    + `<p>NILDash</p>`;
  return { subject, text: lines.join('\n'), html };
}

async function sendNote(to, msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>', to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// Where each approved email stands now. -> Map(id -> 'sent' | 'pending' | 'stopped')
// PENDING includes a temporary hold (a retry, the 4-day rule, the ceiling, a
// compliance recheck): those still go out, so they are never reported as not
// sent. STOPPED is for good: the cadence stopped (a reply first, suppressed,
// the send gate turned it into a call or DM card) or no longer approved.
async function statusOf(pool, ids) {
  const out = new Map();
  if (!ids.length) return out;
  const rows = (await pool.query(
    `SELECT id, status, sent_at, cadence_stopped_at FROM outreach_logs WHERE id = ANY($1::text[])`, [ids.map(String)])).rows;
  for (const r of rows) {
    out.set(String(r.id), r.sent_at ? 'sent'
      : (r.status === 'approved' && !r.cadence_stopped_at) ? 'pending' : 'stopped');
  }
  for (const id of ids) if (!out.has(String(id))) out.set(String(id), 'stopped');
  return out;
}

// ── ONE AGENT'S MORNING ─────────────────────────────────────────────────────
// deps.buildBatch / approveBatch / mailbox / senderAddress stand in for tests.
async function runAgent(pool, agent, { date, deps = {} } = {}) {
  // Claimed only while the switch is still on: an agent who turns it off after
  // the tick picked them is not sent for.
  const claim = await pool.query(
    `INSERT INTO auto_send_runs (agent_id, run_date)
     SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM users WHERE id = $1 AND auto_send_on = TRUE AND archived IS NOT TRUE)
     ON CONFLICT DO NOTHING`, [agent.id, date]);
  if (!claim.rowCount) return { agentId: agent.id, skipped: 'already ran today' };
  const finish = async (approved, offered, note, detail) => {
    await pool.query(`UPDATE auto_send_runs SET finished_at = NOW(), approved = $3, offered = $4, note = $5, detail = $6 WHERE agent_id = $1 AND run_date = $2`,
      [agent.id, date, approved, offered, note ? String(note).slice(0, 300) : null, detail ? JSON.stringify(detail) : null]);
  };
  try {
    // Still ready? A mailbox can disconnect after the switch went on; approving
    // then would only park the emails in the release queue.
    const missing = await missingFor(pool, agent.id, deps);
    if (missing.length) { await finish(0, 0, 'not sent: ' + missing.join('; ')); return { agentId: agent.id, approved: 0, missing }; }
    const Closer = require('./closer');
    const b = deps.buildBatch ? await deps.buildBatch(agent.id) : await Closer.buildBatch(pool, agent.id);
    let items = (b && b.batch) || [];
    // THIS MORNING'S PITCHES, NOT THE BACKLOG. buildBatch takes drafts oldest
    // first with no age limit; a draft older than MAX_AGE_DAYS (a card the
    // agent never saw, behind an expired slot) is left for the agent to approve
    // by hand, never sent under their name by this.
    const fresh = deps.freshIds ? await deps.freshIds(items.map((x) => x.id))
      : new Set((await pool.query(`SELECT id FROM outreach_logs WHERE id = ANY($1::text[]) AND created_at > NOW() - ($2 || ' days')::interval`,
        [items.map((x) => String(x.id)), String(MAX_AGE_DAYS)])).rows.map((r) => String(r.id)));
    const stale = items.length - items.filter((x) => fresh.has(String(x.id))).length;
    items = items.filter((x) => fresh.has(String(x.id)));
    if (!items.length) { await finish(0, 0, stale ? `nothing new to send (${stale} older than ${MAX_AGE_DAYS} days left for the agent)` : ((b && b.note) || 'nothing ready to send')); return { agentId: agent.id, approved: 0, note: b && b.note }; }
    // STILL TRUE? The last look before a pitch goes out unread
    // (services/stillTrue). What fails waits for the agent, as a draft.
    const chk = deps.stillTrue ? await deps.stillTrue(items.map((x) => String(x.id)))
      : await require('./stillTrue').check(pool, agent.id, items.map((x) => String(x.id)));
    const waiting = items.filter((x) => !chk.ok.has(String(x.id)))
      .map((x) => ({ id: String(x.id), athleteName: x.athleteName, brand: x.brand, why: chk.reasons.get(String(x.id)) || 'it needs your eyes' }));
    items = items.filter((x) => chk.ok.has(String(x.id)));
    if (!items.length) {
      await finish(0, 0, `nothing sent: ${waiting.length} waiting for the agent (${waiting.map((w) => w.why).slice(0, 2).join('; ')})`, { items: [], waiting });
      return { agentId: agent.id, approved: 0, waiting: waiting.length };
    }
    const r = deps.approveBatch ? await deps.approveBatch(agent.id, items.map((x) => x.id)) : await Closer.approveBatch(pool, agent.id, { ids: items.map((x) => x.id) });
    const approved = (r && (r.approved || 0)) || 0;
    // The ones approved, as approveBatch reports them (`when`: one per approved draft).
    const ids = new Set(((r && r.when) || []).map((w) => String(w.id)));
    // `to` from buildBatch is { name, title, kind }: the named person, else
    // "the general inbox".
    const toOf = (x) => (x.to && typeof x.to === 'object') ? (x.to.name || null) : (x.to || null);
    const list = items.filter((x) => ids.has(String(x.id))).map((x) => ({ id: String(x.id), athleteName: x.athleteName, brand: x.brand, to: toOf(x) }));
    await finish(approved, items.length, r && (r.note || (r.blocked ? 'blocked' : null)), { items: list, waiting });
    if (approved > 0) { try { require('../jobs/closerRelease').kick(); } catch (_) { /* the release tick will find them */ } }
    return { agentId: agent.id, approved, offered: items.length, waiting: waiting.length };
  } catch (e) {
    await finish(0, 0, 'failed: ' + String(e.message || e).slice(0, 200)).catch(() => {});
    try { require('./ourFault').record('auto-send', String(e.message || e).slice(0, 300), 'autoSend agent=' + agent.id); } catch (_) { /* best effort */ }
    return { agentId: agent.id, error: e.message };
  }
}

// ── THE NOTES, ONCE THE QUEUE HAS WORKED THROUGH ────────────────────────────
// A run is ready for its note when none of its emails is still waiting to go,
// or NOTE_AFTER_MS after it started, whichever is first. Claimed before the
// send (note_at), so two instances never both email: a crash costs one note.
async function notes(pool, { now, deps = {} } = {}) {
  const at = now ? new Date(now) : new Date();
  const runs = (await pool.query(
    `SELECT r.agent_id, r.run_date::text AS run_date, r.started_at, r.detail, u.email, u.name, u.sign_first_name
       FROM auto_send_runs r JOIN users u ON u.id = r.agent_id
      WHERE (r.approved > 0 OR jsonb_array_length(COALESCE(r.detail->'waiting', '[]'::jsonb)) > 0)
        AND r.note_at IS NULL AND r.started_at > $1::timestamptz - INTERVAL '2 days'`, [at])).rows;
  const out = [];
  for (const run of runs) {
    const items = (run.detail && run.detail.items) || [];
    const st = deps.statusOf ? await deps.statusOf(items.map((x) => x.id)) : await statusOf(pool, items.map((x) => x.id));
    const pending = items.filter((x) => st.get(String(x.id)) === 'pending').length;
    if (pending && at - new Date(run.started_at) < NOTE_AFTER_MS) { out.push({ agentId: run.agent_id, waiting: pending }); continue; }
    const sent = items.filter((x) => st.get(String(x.id)) === 'sent');
    const held = items.filter((x) => st.get(String(x.id)) === 'stopped').length;
    const claim = await pool.query(`UPDATE auto_send_runs SET note_at = NOW(), sent = $3, held = $4 WHERE agent_id = $1 AND run_date = $2 AND note_at IS NULL`,
      [run.agent_id, run.run_date, sent.length, held]);
    if (!claim.rowCount) continue;
    const waiting = (run.detail && Array.isArray(run.detail.waiting)) ? run.detail.waiting : [];
    if (!sent.length && !waiting.length) { out.push({ agentId: run.agent_id, sent: 0, held }); continue; }
    try {
      const offUrl = deps.offUrl !== undefined ? deps.offUrl : await offUrlFor(pool, run.agent_id).catch(() => null);
      const msg = noteFor(run, sent, held, pending, { waiting, offUrl });
      await (deps.send ? deps.send(run.email, msg) : sendNote(run.email, msg));
      await pool.query(`UPDATE auto_send_runs SET emailed_at = NOW() WHERE agent_id = $1 AND run_date = $2`, [run.agent_id, run.run_date]);
      out.push({ agentId: run.agent_id, sent: sent.length, held, emailed: true });
    } catch (e) {
      console.error(`[auto-send] note to ${run.agent_id} failed: ${e.message}`);
      out.push({ agentId: run.agent_id, sent: sent.length, held, error: e.message });
    }
  }
  return out;
}

// ── THE ONE-TIME INVITE ─────────────────────────────────────────────────────
// One email to every real agent with athletes who has not turned it on, with
// the one-tap link. Dry run unless send: true. Claimed per agent
// (auto_send_invited_at) before the send, so nobody gets it twice.
const INTERNAL_RE = /@(comptongroupllc\.com|example\.com)$|^claude[-+._]/i;
function inviteFor(user, url) {
  const first = firstOf(user);
  const subject = 'Your pitches can send themselves now';
  const paras = [
    `Hi ${first},`,
    'Quick update from NILDash. Every night we find businesses for your athletes and write the pitches, but they only go out when you approve them. Most mornings that doesn\'t happen, and I get it. You\'re busy.',
    'So now NILDash can send them for you. Every weekday at 9am Central, that morning\'s pitches go out from your own email. Same checks as before: verified addresses only, and no follow-up once a business replies. You get one short email listing what went out, and replies come straight to you.',
    'Before anything sends, NILDash checks the pitch is still right: if an athlete changed schools or positions, or a pitch looks weak, it waits for you instead.',
    'Want them in your own words? Add your pitch script in Settings and NILDash follows it.',
    'This is completely optional. Nothing changes unless you turn it on. If you\'d rather keep approving every pitch yourself, just ignore this email. If you turn it on, you can turn it off any time with one tap.',
    'Turn it on with one tap:',
  ];
  const sign = ['JohnMark', 'Founder, NILDash'];
  const text = paras.join('\n\n') + '\n' + url + '\n\n' + sign.join('\n');
  const html = paras.map((p) => `<p>${esc(p)}</p>`).join('')
    + `<p><a href="${esc(url)}" style="display:inline-block;background:#111827;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;font-weight:600">Send my pitches every morning</a></p>`
    + `<p>${sign.map(esc).join('<br>')}</p>`;
  return { subject, text, html };
}
async function inviteList(pool) {
  await ensureTables(pool);
  const admin = String(process.env.ADMIN_EMAIL || '').toLowerCase();
  const rows = (await pool.query(
    `SELECT id, name, email, sign_first_name FROM users u
      WHERE role = 'agent' AND archived IS NOT TRUE AND auto_send_on IS NOT TRUE AND auto_send_invited_at IS NULL
        AND digest_unsubscribed IS NOT TRUE
        AND EXISTS (SELECT 1 FROM athletes a WHERE a.agent_id = u.id)
      ORDER BY created_at`)).rows;
  // Our own accounts never get it: the same test as the onboarding funnel's
  // (services/coldAgent.isInternal), plus the pattern above as a floor.
  const internal = (u) => { try { return !!require('./coldAgent').isInternal(u, { excludeNames: [], excludeEmails: [] }); } catch (_) { return false; } };
  return rows.filter((u) => u.email && !INTERNAL_RE.test(u.email) && String(u.email).toLowerCase() !== admin && !internal(u));
}
// READY ONLY. An agent with no connected mailbox or no business address
// would tap the button and land on "one thing first": a dead end from an
// email that promised one tap. They are listed, not sent; they get the offer
// in the nightly email once they are ready. exclude: emails never invited.
async function invite(pool, { send = false, deps = {}, exclude = [] } = {}) {
  if (!ON()) return { skipped: 'AUTO_SEND_ON is off: the link would not work yet' };
  const skip = new Set((exclude || []).map((e) => String(e).trim().toLowerCase()).filter(Boolean));
  if (send && !deps.send && !process.env.RESEND_API_KEY) return { skipped: 'RESEND_API_KEY is not set, so nothing was sent and nobody was marked invited' };
  const list = await inviteList(pool);
  const out = [];
  for (const u of list) {
    if (skip.has(String(u.email).toLowerCase())) { out.push({ id: u.id, email: u.email, name: u.name, excluded: true }); continue; }
    const missing = await missingFor(pool, u.id, deps);
    if (missing.length) { out.push({ id: u.id, email: u.email, name: u.name, missing, notReady: true }); continue; }
    if (!send) { out.push({ id: u.id, email: u.email, name: u.name, missing }); continue; }
    const claim = await pool.query(`UPDATE users SET auto_send_invited_at = NOW() WHERE id = $1 AND auto_send_invited_at IS NULL`, [u.id]);
    if (!claim.rowCount) continue;
    const url = await offerUrl(pool, u.id);
    if (!url) continue;
    try {
      const msg = inviteFor(u, url);
      if (deps.send) await deps.send(u.email, msg);
      else {
        if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
        const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
        const r = await resend.emails.send({ from: process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>',
          to: u.email, replyTo: process.env.SALES_FROM_ADDRESS || 'john@comptongroupllc.com', subject: msg.subject, text: msg.text, html: msg.html });
        if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
      }
      out.push({ id: u.id, email: u.email, sent: true, missing });
    } catch (e) {
      // Not sent, so not invited: the next run tries again.
      await pool.query(`UPDATE users SET auto_send_invited_at = NULL WHERE id = $1`, [u.id]).catch(() => {});
      out.push({ id: u.id, email: u.email, error: e.message });
    }
  }
  return { send, list: out };
}

let _running = false;
async function tick(pool, { now, force = false, deps = {} } = {}) {
  if (!ON()) return { skipped: 'AUTO_SEND_ON is off' };
  await ensureTables(pool);
  if (_running) return { skipped: 'already running' };
  _running = true;
  try {
    const noted = await notes(pool, { now, deps }).catch((e) => { console.error('[auto-send] notes:', e.message); return []; });
    const c = central(now);
    if (!force && (['Sat', 'Sun'].includes(c.weekday) || c.minutes < SEND_AT() || c.minutes >= SEND_UNTIL)) return { skipped: 'not the window', notes: noted };
    const agents = (await pool.query(
      `SELECT id, name, email, sign_first_name FROM users
        WHERE auto_send_on = TRUE AND archived IS NOT TRUE AND role IN ('agent', 'admin')
          AND NOT EXISTS (SELECT 1 FROM auto_send_runs r WHERE r.agent_id = users.id AND r.run_date = $1)
        ORDER BY id`, [c.date])).rows;
    const out = [];
    for (const a of agents) out.push(await runAgent(pool, a, { date: c.date, deps }));
    return { date: c.date, agents: out, notes: noted };
  } finally { _running = false; }
}

let _timer = null;
function start(pool) {
  if (_timer) return;
  const go = () => tick(pool).catch((e) => console.error('[auto-send] tick:', e.message));
  _timer = setInterval(go, 5 * 60 * 1000);
  if (_timer.unref) _timer.unref();
  console.log(`[auto-send] ${ON() ? 'on' : 'off (AUTO_SEND_ON)'}`);
}

module.exports = { ON, SEND_AT, ensureTables, status, set, missingFor, noteFor, runAgent, notes, statusOf, tick, start, central,
  tokenFor, offerUrl, offUrlFor, byToken, page, NOTE_AFTER_MS, inviteFor, inviteList, invite };
