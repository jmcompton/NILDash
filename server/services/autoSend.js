'use strict';
// ── DONE FOR YOU: THE MORNING'S PITCHES GO OUT WITHOUT A LOGIN ─────────────
//
// The product only works when an agent logs in and approves, and most agents
// do not log in (Oct 2026: 11 of 18 skipped as inactive; no agent email sent
// for five days). So an agent can say once, in Settings, "send my pitches
// every morning", and NILDash approves that morning's email batch for them.
//
// HOW IT SENDS. Exactly the way the agent's own "approve all" does: the
// Closer's batch (services/closer buildBatch: the allocator, the daily
// ceiling, suppressed and missing addresses already dropped) is approved with
// approveBatch, and jobs/closerRelease sends each email from the agent's own
// mailbox with every send-time check unchanged (a reply first, suppression,
// the compliance gate, the 4-day rule, duplicate subjects). Nothing here
// talks to a mailbox.
//
// WHEN. Weekdays, once a day per agent, from AUTO_SEND_AT (9:00 Central) to
// 3:00 Central. A claim row (auto_send_runs) makes it once, across restarts
// and instances.
//
// WHAT THE AGENT HEARS. One short email per morning that sent anything: how
// many went out, for which athletes, to which businesses. Replies come to
// their own inbox, as they always did.
//
// THE SWITCHES. AUTO_SEND_ON=true turns the job on at all (off: nothing here
// runs, and Settings says it is not available yet). Per agent, users.auto_send_on,
// set in Settings; turning it on needs a connected mailbox and a business
// address, and says which is missing.

const truthy = (v) => /^(1|true|yes|on)$/i.test(String(v == null ? '' : v).trim());
const ON = () => truthy(process.env.AUTO_SEND_ON);
const intEnv = (k, d) => { const n = parseInt(process.env[k], 10); return Number.isFinite(n) ? n : d; };
const SEND_AT = () => intEnv('AUTO_SEND_AT', 9 * 60);       // Central minutes
const SEND_UNTIL = 15 * 60;
const CENTRAL = 'America/Chicago';

let _ready = null;
function ensureTables(pool) {
  if (_ready) return _ready;
  _ready = (async () => {
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_send_on BOOLEAN NOT NULL DEFAULT FALSE`);
    await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS auto_send_since TIMESTAMPTZ`);
    await pool.query(`CREATE TABLE IF NOT EXISTS auto_send_runs (
      agent_id TEXT NOT NULL, run_date DATE NOT NULL, started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), finished_at TIMESTAMPTZ,
      approved INTEGER NOT NULL DEFAULT 0, offered INTEGER NOT NULL DEFAULT 0, note TEXT, detail JSONB, emailed_at TIMESTAMPTZ,
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
  const last = (await pool.query(`SELECT run_date::text AS date, approved, note FROM auto_send_runs WHERE agent_id = $1 ORDER BY run_date DESC LIMIT 1`, [agentId])).rows[0] || null;
  return { available: ON(), on: !!u.auto_send_on, since: u.auto_send_since || null, ready: !missing.length, missing, last, sendsAt: '9:00 am Central, weekdays' };
}

// What must be in place before NILDash sends for an agent.
async function missingFor(pool, agentId, deps = {}) {
  const out = [];
  try {
    const mb = deps.mailbox ? await deps.mailbox(agentId) : await require('./emailStore').sendingMailbox(agentId);
    if (!mb || !mb.connected) out.push('connect the mailbox your pitches send from (Settings, Email)');
  } catch (_) { out.push('connect the mailbox your pitches send from (Settings, Email)'); }
  try {
    const sa = deps.senderAddress ? await deps.senderAddress(agentId) : await require('./canSpam').senderAddress(pool, agentId);
    if (!sa || !sa.ok) out.push('add your business address (Settings, the first box)');
  } catch (_) { out.push('add your business address (Settings, the first box)'); }
  return out;
}

// Settings' switch. -> { ok, on, missing?, error? }
async function set(pool, agentId, on, deps = {}) {
  await ensureTables(pool);
  if (on) {
    if (!ON()) return { ok: false, error: 'Automatic sending is not available yet.' };
    const missing = await missingFor(pool, agentId, deps);
    if (missing.length) return { ok: false, missing, error: 'Before NILDash can send for you: ' + missing.join('; ') + '.' };
    await pool.query(`UPDATE users SET auto_send_on = TRUE, auto_send_since = COALESCE(auto_send_since, NOW()) WHERE id = $1`, [agentId]);
  } else {
    await pool.query(`UPDATE users SET auto_send_on = FALSE, auto_send_since = NULL WHERE id = $1`, [agentId]);
  }
  return { ok: true, on: !!on };
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The morning note to the agent. -> { subject, text, html }
function noteFor(agent, items) {
  const first = String((agent && (agent.sign_first_name || agent.name)) || '').trim().split(/\s+/)[0] || 'there';
  const byAthlete = new Map();
  for (const it of items) {
    const k = it.athleteName || 'Your athlete';
    if (!byAthlete.has(k)) byAthlete.set(k, []);
    byAthlete.get(k).push(it);
  }
  const n = items.length;
  const subject = `NILDash sent ${n} pitch${n === 1 ? '' : 'es'} for your athletes this morning`;
  const lines = [`Hi ${first},`, '', `NILDash sent ${n} pitch${n === 1 ? '' : 'es'} from your mailbox this morning:`, ''];
  for (const [ath, list] of byAthlete) {
    lines.push(`${ath}:`);
    for (const it of list) lines.push(`  - ${it.brand}${it.to ? ', to ' + it.to : ''}`);
    lines.push('');
  }
  lines.push('Replies come straight to your inbox. To stop automatic sending, turn it off in Settings.', '', 'NILDash');
  const html = `<p>Hi ${esc(first)},</p><p>NILDash sent ${n} pitch${n === 1 ? '' : 'es'} from your mailbox this morning:</p>`
    + Array.from(byAthlete).map(([ath, list]) => `<p><b>${esc(ath)}</b></p><ul>${list.map((it) => `<li>${esc(it.brand)}${it.to ? ', to ' + esc(it.to) : ''}</li>`).join('')}</ul>`).join('')
    + `<p>Replies come straight to your inbox. To stop automatic sending, turn it off in Settings.</p><p>NILDash</p>`;
  return { subject, text: lines.join('\n'), html };
}

async function sendNote(to, msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('./resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>', to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// One agent's morning. deps.buildBatch / deps.approveBatch / deps.send stand in for tests.
async function runAgent(pool, agent, { date, deps = {} } = {}) {
  const claim = await pool.query(`INSERT INTO auto_send_runs (agent_id, run_date) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [agent.id, date]);
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
    const items = (b && b.batch) || [];
    if (!items.length) { await finish(0, 0, (b && b.note) || 'nothing ready to send'); return { agentId: agent.id, approved: 0, note: b && b.note }; }
    const r = deps.approveBatch ? await deps.approveBatch(agent.id, items.map((x) => x.id)) : await Closer.approveBatch(pool, agent.id, { ids: items.map((x) => x.id) });
    const approved = (r && (r.approved || 0)) || 0;
    // The ones approved, as approveBatch reports them (`when`: one per approved draft).
    const sentIds = new Set(((r && r.when) || []).map((w) => String(w.id)));
    const sent = items.filter((x) => sentIds.has(String(x.id))).map((x) => ({ athleteName: x.athleteName, brand: x.brand, to: x.to || null }));
    await finish(approved, items.length, r && (r.note || (r.blocked ? 'blocked' : null)), { sent: sent.slice(0, 60) });
    if (approved > 0) {
      try { require('../jobs/closerRelease').kick(); } catch (_) { /* the release tick will find them */ }
      try {
        const msg = noteFor(agent, sent);
        await (deps.send ? deps.send(agent.email, msg) : sendNote(agent.email, msg));
        await pool.query(`UPDATE auto_send_runs SET emailed_at = NOW() WHERE agent_id = $1 AND run_date = $2`, [agent.id, date]);
      } catch (e) { console.error(`[auto-send] note to ${agent.id} failed: ${e.message}`); }
    }
    return { agentId: agent.id, approved, offered: items.length };
  } catch (e) {
    await finish(0, 0, 'failed: ' + String(e.message || e).slice(0, 200)).catch(() => {});
    require('./ourFault').record('auto-send', String(e.message || e).slice(0, 300), 'autoSend agent=' + agent.id);
    return { agentId: agent.id, error: e.message };
  }
}

let _running = false;
async function tick(pool, { now, force = false, deps = {} } = {}) {
  if (!ON()) return { skipped: 'AUTO_SEND_ON is off' };
  await ensureTables(pool);
  const c = central(now);
  if (!force && (['Sat', 'Sun'].includes(c.weekday) || c.minutes < SEND_AT() || c.minutes >= SEND_UNTIL)) return { skipped: 'not the window' };
  if (_running) return { skipped: 'already running' };
  _running = true;
  try {
    const agents = (await pool.query(
      `SELECT id, name, email, sign_first_name FROM users
        WHERE auto_send_on = TRUE AND archived IS NOT TRUE AND role IN ('agent', 'admin')
          AND NOT EXISTS (SELECT 1 FROM auto_send_runs r WHERE r.agent_id = users.id AND r.run_date = $1)
        ORDER BY id`, [c.date])).rows;
    const out = [];
    for (const a of agents) out.push(await runAgent(pool, a, { date: c.date, deps }));
    return { date: c.date, agents: out };
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

module.exports = { ON, SEND_AT, ensureTables, status, set, missingFor, noteFor, runAgent, tick, start, central };
