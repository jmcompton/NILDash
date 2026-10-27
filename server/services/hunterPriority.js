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

module.exports = { priorityList, rankOf, split };
