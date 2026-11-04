'use strict';
// ── THE PORTAL ROOM MORNING EMAIL ───────────────────────────────────────────
//
// One email per agent, 7 to 9am Central, only on a morning there is
// something to act on, for each of his football clients with schools on the
// board (services/portalRoom/workspace):
//   - next steps due today or overdue;
//   - an offer that expires within 2 days;
//   - after a commit: the reports and paperwork due within 3 days;
//   - a head coach change at one of his target schools in the last 2 days;
//   - the window: 14, 7 and 1 days before it opens, the day it opens, and 3
//     and 1 days before it closes;
//   - schools that opened his one-pager since yesterday morning.
// Claimed per agent per day, so a restart never sends it twice. Off with
// PORTAL_ALERTS=off. Nothing in it is sent to anyone but the agent.

const W = require('./workspace');
const crypto = require('crypto');

// The one-click "stop these" link: signed, so nobody can turn off someone else's.
const secret = () => process.env.SESSION_SECRET || process.env.PORTAL_ALERT_SECRET || 'nildash-portal-alerts';
const stopSig = (agentId) => crypto.createHmac('sha256', secret()).update('portal-alerts-off:' + agentId).digest('hex').slice(0, 32);
function stopUrl(agentId) {
  const base = (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');
  return `${base}/portal-alerts/off?a=${encodeURIComponent(agentId)}&s=${stopSig(agentId)}`;
}
async function turnOff(pool, agentId, sig) {
  await ensureTable(pool);
  const a = String(agentId || '');
  if (!a || !sig || String(sig).length !== 32 || !crypto.timingSafeEqual(Buffer.from(String(sig)), Buffer.from(stopSig(a)))) return false;
  await pool.query(`INSERT INTO portal_alert_optout (agent_id) VALUES ($1) ON CONFLICT DO NOTHING`, [a]);
  return true;
}

const on = () => String(process.env.PORTAL_ALERTS || '').toLowerCase() !== 'off';
const centralHour = (now) => parseInt(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Chicago', hour: 'numeric', hourCycle: 'h23' }).format(now), 10);
const WINDOW_OPEN_DAYS = [14, 7, 1, 0];
const WINDOW_CLOSE_DAYS = [3, 1];

let _ready = null;
function ensureTable(pool) {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS portal_alert_sends (
    agent_id TEXT NOT NULL, day DATE NOT NULL, items INTEGER NOT NULL DEFAULT 0, sent_at TIMESTAMPTZ, error TEXT,
    PRIMARY KEY (agent_id, day))`).then(() => pool.query(`CREATE TABLE IF NOT EXISTS portal_alert_optout (agent_id TEXT PRIMARY KEY, at TIMESTAMPTZ NOT NULL DEFAULT NOW())`)).catch((e) => { _ready = null; throw e; });
  return _ready;
}

// What one client's morning holds. ws: a workspace. -> [{ kind, text }]
function itemsFor(ws, now = new Date()) {
  const out = [];
  const name = (ws.athlete && ws.athlete.name) || 'Your client';
  for (const c of ws.cards || []) {
    if (c.due) out.push({ kind: 'due', text: `${c.school}: ${c.nextStep || 'next step'} (${c.dueIn === 0 ? 'due today' : `${-c.dueIn} day${c.dueIn === -1 ? '' : 's'} overdue`})` });
  }
  const ob = ws.offers || {};
  for (const d of ob.deadlines || []) {
    if (/offer expires/.test(d.text) && d.days >= 0 && d.days <= 2) out.push({ kind: 'offer', text: `${d.text} ${d.days === 0 ? 'today' : d.days === 1 ? 'tomorrow' : 'in 2 days'}` });
  }
  if (ob.commit) {
    for (const it of ob.commit.items || []) {
      if (!it.dueBy) continue;
      const days = W.daysBetween(ws.today || W.chicagoDay(now), it.dueBy);
      if (days >= 0 && days <= 3) out.push({ kind: 'commit', text: `${it.text} Due ${days === 0 ? 'today' : `in ${days} day${days === 1 ? '' : 's'}`}.` });
    }
  }
  for (const c of ws.cards || []) {
    const ch = c.coachingChange;
    if (!ch || !ch.date || ['passed', 'committed'].includes(c.stage)) continue;
    const ago = W.daysBetween(String(ch.date).slice(0, 10), ws.today || W.chicagoDay(now));
    if (ago >= 0 && ago <= 2) out.push({ kind: 'coach', text: `${c.school} has a head coach change: ${c.coachingLine || 'a new staff is coming'}` });
  }
  const dayAgo = now.getTime() - 24 * 3600 * 1000;
  for (const c of ws.cards || []) {
    if (c.opens && c.opens.lastOpenAt && new Date(c.opens.lastOpenAt).getTime() >= dayAgo) out.push({ kind: 'opened', text: `Someone at ${c.school} opened his one-pager (${c.opens.opens} open${c.opens.opens === 1 ? '' : 's'} so far)` });
  }
  return out.map((x) => ({ ...x, client: name }));
}

function windowLine(ws) {
  const w = ws && ws.window;
  if (!w) return null;
  if (WINDOW_OPEN_DAYS.includes(w.daysToOpen)) return w.daysToOpen === 0 ? 'The portal window opens today.' : `The portal window opens in ${w.daysToOpen} day${w.daysToOpen === 1 ? '' : 's'}.`;
  if (w.isOpen && WINDOW_CLOSE_DAYS.includes(w.daysToClose)) return `The portal window closes in ${w.daysToClose} day${w.daysToClose === 1 ? '' : 's'}.`;
  return null;
}

function emailFor(agent, blocks, winLine) {
  const first = String((agent && agent.name) || '').trim().split(/\s+/)[0] || 'there';
  const base = (process.env.APP_URL || 'https://mynildash.com').replace(/\/$/, '');
  const n = blocks.reduce((s, b) => s + b.items.length, 0);
  const subject = winLine && !n ? winLine : `Portal Room: ${n} thing${n === 1 ? '' : 's'} for today`;
  const lines = [`Hi ${first},`, ''];
  if (winLine) lines.push(winLine, '');
  for (const b of blocks) {
    if (!b.items.length) continue;
    lines.push(`${b.name}:`);
    for (const it of b.items) lines.push(`- ${it.text}`);
    lines.push(`  ${base}/portal-room?a=${encodeURIComponent(b.athleteId)}`, '');
  }
  lines.push('NILDash', '', `You get this because you have clients on your Portal Room board. Stop these emails: ${stopUrl(agent.id)}`);
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<p>Hi ${esc(first)},</p>${winLine ? `<p><b>${esc(winLine)}</b></p>` : ''}`
    + blocks.filter((b) => b.items.length).map((b) => `<p><b>${esc(b.name)}</b></p><ul>${b.items.map((it) => `<li>${esc(it.text)}</li>`).join('')}</ul><p><a href="${esc(`${base}/portal-room?a=${encodeURIComponent(b.athleteId)}`)}">Open his board</a></p>`).join('')
    + `<p>NILDash</p><p style="color:#666;font-size:12px">You get this because you have clients on your Portal Room board. <a href="${esc(stopUrl(agent.id))}">Stop these emails</a>.</p>`;
  return { subject, text: lines.join('\n'), html };
}

async function _send(msg) {
  if (!process.env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set');
  const resend = require('../resendChecked').makeResend(process.env.RESEND_API_KEY);
  const r = await resend.emails.send({ from: process.env.NIGHTLY_DIGEST_FROM || 'NILDash <noreply@mynildash.com>', reply_to: 'john@comptongroupllc.com', to: msg.to, subject: msg.subject, text: msg.text, html: msg.html });
  if (r && r.error) throw new Error(r.error.message || JSON.stringify(r.error));
  return r;
}

// One agent's morning. -> { sent, items, skipped? }
async function runAgent(pool, store, agentId, { now = new Date(), deps = {} } = {}) {
  await ensureTable(pool);
  const day = W.chicagoDay(now);
  const claim = await pool.query(`INSERT INTO portal_alert_sends (agent_id, day) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING agent_id`, [agentId, day]);
  if (!claim.rows.length) return { sent: false, skipped: 'already today' };
  const agent = await store.getUser(agentId);
  if (!agent || !agent.email) return { sent: false, skipped: 'no agent' };
  if ((await pool.query(`SELECT 1 FROM portal_alert_optout WHERE agent_id = $1`, [agentId])).rows.length) return { sent: false, skipped: 'turned off' };
  const ids = (await pool.query(`SELECT DISTINCT athlete_id FROM portal_targets WHERE agent_id = $1 AND stage <> 'passed'`, [agentId])).rows.map((r) => r.athlete_id);
  const blocks = [];
  let winLine = null;
  for (const id of ids) {
    const ath = await store.getAthlete(id);
    if (!ath || ath.agentId !== agentId) continue;
    const ws = await (deps.workspace || W.workspace)(pool, store, agent, ath, { now });
    winLine = winLine || windowLine(ws);
    blocks.push({ athleteId: id, name: ath.name || 'Your client', items: itemsFor(ws, now) });
  }
  const n = blocks.reduce((s, b) => s + b.items.length, 0);
  if (!n && !winLine) { await pool.query(`UPDATE portal_alert_sends SET items = 0 WHERE agent_id = $1 AND day = $2`, [agentId, day]); return { sent: false, items: 0 }; }
  const msg = emailFor(agent, blocks, winLine);
  try {
    await (deps.send || _send)({ to: agent.email, ...msg });
    await pool.query(`UPDATE portal_alert_sends SET items = $3, sent_at = NOW() WHERE agent_id = $1 AND day = $2`, [agentId, day, n]);
    return { sent: true, items: n, subject: msg.subject, text: msg.text };
  } catch (e) {
    await pool.query(`UPDATE portal_alert_sends SET error = $3 WHERE agent_id = $1 AND day = $2`, [agentId, day, String(e.message).slice(0, 300)]);
    return { sent: false, items: n, error: e.message };
  }
}

// The scheduler's tick: 7 to 9am Central, every agent with a board.
async function tick(pool, store, { now = new Date(), deps = {} } = {}) {
  if (!on()) return { skipped: 'off' };
  const h = centralHour(now);
  if (h < 7 || h >= 9) return { skipped: 'not the hour' };
  await ensureTable(pool);
  const agents = (await pool.query(`SELECT DISTINCT agent_id FROM portal_targets WHERE stage <> 'passed'`).catch(() => ({ rows: [] }))).rows.map((r) => r.agent_id);
  const out = [];
  for (const a of agents) {
    try { out.push({ agentId: a, ...(await runAgent(pool, store, a, { now, deps })) }); }
    catch (e) { out.push({ agentId: a, error: e.message }); }
  }
  return { agents: agents.length, sent: out.filter((x) => x.sent).length, out };
}

module.exports = { stopUrl, turnOff, on, itemsFor, windowLine, emailFor, runAgent, tick, ensureTable, centralHour };
