'use strict';
// ── WHO GETS TONIGHT'S HUNTER CREDITS FIRST (HUNTER_PRIORITY_AGENTS) ────────
//
// The night's Hunter allowance (services/hunterPace) is one pool, and agents
// ran four at a time in signup order, so whoever started first spent it. On
// 2026-10-27 that left three of a paying agent's athletes at zero cards while
// the pool went to other accounts.
//
// HUNTER_PRIORITY_AGENTS is a comma-separated list of agent emails or full
// names (case-insensitive), most important first. Those agents run first, as
// their own phase, so they reach the allowance before anyone else; everyone
// else runs after them in the usual order. Unset or empty: nothing changes.
// Names and emails live in the environment, not in this public repo.
//
// Also a list in the database (hunter_priority_agents), edited from the admin
// routes (GET/POST/DELETE /api/admin/hunter-priority), so an agent on a trial
// that matters can be put first without touching the environment. The
// environment's names come first, then the database's, in the order added.

function priorityList(raw) {
  const v = raw == null ? process.env.HUNTER_PRIORITY_AGENTS : raw;
  return String(v || '').split(',').map((s) => s.trim().toLowerCase().replace(/\s+/g, ' ')).filter(Boolean);
}

// -> the index in the list, or -1 when the agent is not on it.
function rankOf(agent, list) {
  const email = String((agent && agent.email) || '').trim().toLowerCase();
  const name = String((agent && agent.name) || '').trim().toLowerCase().replace(/\s+/g, ' ');
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (p.includes('@') ? (email && email === p) : (name && name === p)) return i;
  }
  return -1;
}

// -> { first: priority agents in list order, rest: everyone else in the order given }
function split(agents, list) {
  const l = Array.isArray(list) ? list : priorityList();
  const first = [], rest = [];
  for (const a of agents || []) {
    const r = l.length ? rankOf(a, l) : -1;
    if (r >= 0) first.push({ a, r }); else rest.push(a);
  }
  first.sort((x, y) => x.r - y.r);
  return { first: first.map((x) => x.a), rest };
}

let _ready = null;
function ensureTable(pool) {
  if (_ready) return _ready;
  _ready = pool.query(`CREATE TABLE IF NOT EXISTS hunter_priority_agents (
    who TEXT PRIMARY KEY, note TEXT, added_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`).catch((e) => { _ready = null; throw e; });
  return _ready;
}
const clean = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

// The environment's list, then the database's. A database that cannot be
// read leaves the environment's list, so the night still runs.
async function loadList(pool, raw) {
  const env = priorityList(raw);
  if (!pool) return env;
  try {
    await ensureTable(pool);
    const r = await pool.query(`SELECT who FROM hunter_priority_agents ORDER BY added_at, who`);
    const out = env.slice();
    for (const row of r.rows) { const w = clean(row.who); if (w && !out.includes(w)) out.push(w); }
    return out;
  } catch (e) { console.warn('[hunter-priority] list read failed:', e.message); return env; }
}
async function add(pool, who, note) {
  const w = clean(who);
  if (!w || w.length > 160) { const e = new Error('Give an agent email or full name.'); e.status = 400; throw e; }
  await ensureTable(pool);
  await pool.query(`INSERT INTO hunter_priority_agents (who, note) VALUES ($1, $2) ON CONFLICT (who) DO UPDATE SET note = COALESCE(EXCLUDED.note, hunter_priority_agents.note)`,
    [w, note ? String(note).slice(0, 200) : null]);
  return w;
}
async function remove(pool, who) {
  await ensureTable(pool);
  const r = await pool.query(`DELETE FROM hunter_priority_agents WHERE who = $1`, [clean(who)]);
  return r.rowCount;
}
async function listRows(pool) {
  await ensureTable(pool);
  return (await pool.query(`SELECT who, note, added_at FROM hunter_priority_agents ORDER BY added_at, who`)).rows;
}

module.exports = { priorityList, rankOf, split, loadList, add, remove, listRows, ensureTable };
