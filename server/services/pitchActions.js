'use strict';
// ── WHO APPROVED WHAT, AND FROM WHERE ───────────────────────────────────────
//
// Agents were not logging in to approve pitches, so deals stalled. One-tap
// Approve and Skip from the nightly digest is the answer, and this table is how
// we find out whether it worked: every approve and every skip is logged here
// with the channel it came through -- 'email', 'reminder_email' or 'dashboard'
// -- so "do agents act more from the email than the app" is a query rather than
// an opinion.
//
// IT IS A LOG, NOT A STATE. outreach_logs is still the truth about whether a
// pitch is approved, skipped or waiting; nothing reads this table to decide
// anything. That matters: a failed write here must never stop a pitch going
// out, so every call is best-effort and returns rather than throws.

async function ensureTable(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pitch_actions (
      id         SERIAL PRIMARY KEY,
      pitch_id   TEXT NOT NULL,
      agent_id   TEXT,
      action     TEXT NOT NULL,
      source     TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`).catch((e) => console.error('[pitchActions] ensureTable:', e.message));
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pitch_actions_pitch ON pitch_actions (pitch_id)`)
    .catch(() => {});
  await pool.query(
    `CREATE INDEX IF NOT EXISTS idx_pitch_actions_agent_at ON pitch_actions (agent_id, created_at DESC)`)
    .catch(() => {});
}

const ACTIONS = ['approve', 'skip'];
const SOURCES = ['email', 'reminder_email', 'dashboard'];

// log(pool, { pitchId, agentId, action, source }) -> true when a row landed.
// Never throws: this is a record of what happened, not part of making it
// happen, and an agent's approve must not fail because a log table is full.
async function log(pool, { pitchId, agentId, action, source } = {}) {
  const a = String(action || '').trim().toLowerCase();
  const s = String(source || '').trim().toLowerCase();
  if (!pitchId || !ACTIONS.includes(a) || !SOURCES.includes(s)) {
    console.error(`[pitchActions] refused: pitch=${pitchId} action=${action} source=${source}`);
    return false;
  }
  try {
    await pool.query(
      `INSERT INTO pitch_actions (pitch_id, agent_id, action, source) VALUES ($1,$2,$3,$4)`,
      [String(pitchId), agentId ? String(agentId) : null, a, s]);
    return true;
  } catch (e) {
    console.error('[pitchActions] log:', e.message);
    return false;
  }
}

// Several at once, for approveBatch: one statement rather than N round trips.
async function logMany(pool, rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) =>
    r && r.pitchId && ACTIONS.includes(String(r.action || '').toLowerCase()) && SOURCES.includes(String(r.source || '').toLowerCase()));
  if (!list.length) return 0;
  try {
    const vals = [], params = [];
    list.forEach((r, i) => {
      const b = i * 4;
      vals.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4})`);
      params.push(String(r.pitchId), r.agentId ? String(r.agentId) : null,
        String(r.action).toLowerCase(), String(r.source).toLowerCase());
    });
    await pool.query(
      `INSERT INTO pitch_actions (pitch_id, agent_id, action, source) VALUES ${vals.join(',')}`, params);
    return list.length;
  } catch (e) {
    console.error('[pitchActions] logMany:', e.message);
    return 0;
  }
}

// Admin only: approvals and skips by channel over a window. The whole point of
// the table -- it answers whether the email is doing the work.
async function byChannel(pool, days) {
  const n = Math.min(365, Math.max(1, Number(days) || 30));
  try {
    const r = await pool.query(
      `SELECT source, action, COUNT(*)::int AS n
         FROM pitch_actions WHERE created_at > NOW() - ($1 || ' days')::interval
        GROUP BY source, action ORDER BY source, action`, [String(n)]);
    return r.rows;
  } catch (e) { console.error('[pitchActions] byChannel:', e.message); return []; }
}

module.exports = { ACTIONS, SOURCES, ensureTable, log, logMany, byChannel };
