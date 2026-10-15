'use strict';
// ── HOW LONG THE NIGHT TAKES, BEFORE AND AFTER ─────────────────────────────
//
// scripts/night-length.js, /api/admin/scripts/night-length. Read from one
// night's run rows (outreach_queue_runs): each agent's start and finish, and
// each athlete's own time (details[].loop.elapsedMs) and what stopped it.
//
//   before   what the night measured: the first agent's start to the last
//            agent's finish
//   after    the same athletes scheduled the way the code now runs them under
//            EMAIL_FIVE_ON: ATHLETE_CONC athletes of an agent at a time, AGENT
//            CONC agents at a time, a 15-minute ceiling. Two figures:
//              fastest   an athlete the 8-minute ceiling stopped needs no more
//                        time than it had
//              slowest   every such athlete uses the full new ceiling
//            Everything else an agent did (retry passes, the roster read) is
//            added after its athletes, as measured.
//
// The scheduling is the same "next job to whichever worker is free first"
// the run uses, so it is a model of the code, not a guess at it.

const MIN = 60000;

// List scheduling: each job goes to the worker that is free first.
function makespan(durations, workers) {
  const free = new Array(Math.max(1, workers | 0) || 1).fill(0);
  for (const d of durations) {
    let i = 0;
    for (let k = 1; k < free.length; k++) if (free[k] < free[i]) i = k;
    free[i] += Math.max(0, Number(d) || 0);
  }
  return Math.max(0, ...free);
}

// agents: [{ athletes: [ms...], tailMs }] in the order the run takes them.
function simulate(agents, { agentConc = 4, athleteConc = 1 } = {}) {
  const perAgent = agents.map((a) => makespan(a.athletes, athleteConc) + Math.max(0, a.tailMs || 0));
  return { perAgent, night: makespan(perAgent, agentConc) };
}

async function gather(pool, { runDate } = {}) {
  const day = runDate || ((await pool.query(`SELECT MAX(run_date)::text AS d FROM outreach_queue_runs WHERE finished_at IS NOT NULL`)).rows[0] || {}).d;
  if (!day) return { runDate: null, rows: [] };
  const rows = (await pool.query(
    `SELECT r.agent_id, u.name AS agent_name, r.created_at, r.finished_at, r.filled, r.details
       FROM outreach_queue_runs r LEFT JOIN users u ON u.id = r.agent_id
      WHERE r.run_date = $1 ORDER BY r.created_at`, [day])).rows;
  // Hunter on that night: the faults the alert counted, and the call log when
  // it exists (hunter_call_log, from this change on).
  const lo = rows.length ? rows[0].created_at : null;
  const hi = rows.length ? rows.reduce((m, r) => (r.finished_at && r.finished_at > m ? r.finished_at : m), rows[0].created_at) : null;
  let faults = [], calls = [];
  if (lo && hi) {
    faults = (await pool.query(
      `SELECT reason FROM service_faults WHERE service = 'hunter' AND at BETWEEN $1 AND $2`, [lo, hi]).catch(() => ({ rows: [] }))).rows;
    calls = (await pool.query(
      `SELECT endpoint, ms, outcome, status, retries FROM hunter_call_log WHERE at BETWEEN $1 AND $2`, [lo, hi]).catch(() => ({ rows: [] }))).rows;
  }
  return { runDate: day, rows, faults, calls };
}

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

// Pure: the before/after figures from gather()'s rows.
function build(g, { agentConc = 4, athleteConc = 3, oldCeilingMs = 8 * MIN, newCeilingMs = 15 * MIN } = {}) {
  const agents = [];
  for (const r of g.rows || []) {
    const details = Array.isArray(r.details) ? r.details : [];
    const ath = details.filter((d) => d && d.athleteId).map((d) => ({
      name: d.athleteName || d.athleteId,
      ms: Math.max(0, Number(d.loop && d.loop.elapsedMs) || 0),
      hitLimit: !!(d.loop && d.loop.stop === 'time'),
      filled: Number(d.filled) || 0,
    }));
    const measured = r.finished_at && r.created_at ? Math.max(0, new Date(r.finished_at) - new Date(r.created_at)) : null;
    const athleteSum = ath.reduce((s, a) => s + a.ms, 0);
    agents.push({ agentId: r.agent_id, name: r.agent_name || r.agent_id, athletes: ath, measured, start: r.created_at, finish: r.finished_at,
      tailMs: measured != null ? Math.max(0, measured - athleteSum) : 0, hitLimit: ath.filter((a) => a.hitLimit).length });
  }
  const starts = agents.map((a) => a.start).filter(Boolean).map((d) => new Date(d).getTime());
  const finishes = agents.map((a) => a.finish).filter(Boolean).map((d) => new Date(d).getTime());
  const measuredNight = starts.length && finishes.length ? Math.max(...finishes) - Math.min(...starts) : null;
  const model = (conc, ceilingFor) => simulate(agents.map((a) => ({ athletes: a.athletes.map(ceilingFor), tailMs: a.tailMs })), { agentConc, athleteConc: conc });
  const oneAtATime = model(1, (a) => a.ms);
  const fastest = model(athleteConc, (a) => a.ms);
  const slowest = model(athleteConc, (a) => (a.hitLimit ? Math.max(a.ms, newCeilingMs) : a.ms));
  const slowestOneAtATime = model(1, (a) => (a.hitLimit ? Math.max(a.ms, newCeilingMs) : a.ms));
  const reasons = (g.faults || []).map((f) => String(f.reason || ''));
  const finder = (g.calls || []).filter((c) => c.endpoint === 'email-finder');
  const finderMs = finder.filter((c) => c.ms != null && c.outcome !== 'TIMEOUT').map((c) => Number(c.ms));
  return {
    runDate: g.runDate, agents, agentConc, athleteConc, oldCeilingMs, newCeilingMs,
    before: { measured: measuredNight, modeled: oneAtATime.night },
    after: { fastest: fastest.night, slowest: slowest.night, perAgentFastest: fastest.perAgent, perAgentSlowest: slowest.perAgent },
    slowestOneAtATime: slowestOneAtATime.night,
    hunter: {
      finderTimeouts: reasons.filter((x) => /^TIMEOUT: email finder/.test(x)).length,
      otherTimeouts: reasons.filter((x) => /^TIMEOUT:/.test(x) && !/^TIMEOUT: email finder/.test(x)).length,
      rateLimited: reasons.filter((x) => /^HTTP_429/.test(x)).length,
      unauthorized: reasons.filter((x) => /^HTTP_401/.test(x)).length,
      logged: { finder: finder.length, finderTimeouts: finder.filter((c) => c.outcome === 'TIMEOUT').length,
        backoffs: (g.calls || []).filter((c) => c.outcome === 'BACKOFF').length,
        p50: pct(finderMs, 50), p90: pct(finderMs, 90), max: finderMs.length ? Math.max(...finderMs) : null },
    },
  };
}

const hm = (ms) => {
  if (ms == null) return 'unknown';
  const m = Math.round(ms / MIN);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

function format(b) {
  const L = [];
  L.push(`NIGHT LENGTH: ${b.runDate || 'no finished run found'}`);
  if (!b.agents.length) return L.join('\n');
  const n = b.agents.reduce((s, a) => s + a.athletes.length, 0);
  const lim = b.agents.reduce((s, a) => s + a.hitLimit, 0);
  L.push(`${b.agents.length} agent(s), ${n} athlete(s); ${lim} stopped by the ${Math.round(b.oldCeilingMs / MIN)}-minute limit.`);
  L.push('');
  L.push(`BEFORE  measured: ${hm(b.before.measured)}   (one athlete at a time, modeled from the same record: ${hm(b.before.modeled)})`);
  L.push(`AFTER   ${b.athleteConc} athletes at a time per agent, ${b.agentConc} agents at a time, ${Math.round(b.newCeilingMs / MIN)}-minute ceiling:`);
  L.push(`          fastest ${hm(b.after.fastest)}   (an athlete the old limit stopped needs no more time)`);
  L.push(`          slowest ${hm(b.after.slowest)}   (every such athlete uses the full ${Math.round(b.newCeilingMs / MIN)} minutes)`);
  L.push(`        For comparison, ${Math.round(b.newCeilingMs / MIN)} minutes one at a time would take up to ${hm(b.slowestOneAtATime)}.`);
  L.push('');
  L.push('PER AGENT                         athletes  hit limit   before      after (fastest - slowest)');
  b.agents.forEach((a, i) => {
    L.push(`  ${String(a.name).slice(0, 30).padEnd(30)}  ${String(a.athletes.length).padStart(8)}  ${String(a.hitLimit).padStart(9)}   ${hm(a.measured).padEnd(10)}  ${hm(b.after.perAgentFastest[i])} - ${hm(b.after.perAgentSlowest[i])}`);
  });
  const h = b.hunter;
  L.push('');
  L.push('HUNTER THAT NIGHT');
  L.push(`  email finder timeouts (our ${'abort'}): ${h.finderTimeouts}; other timeouts: ${h.otherTimeouts}; rate limited (429): ${h.rateLimited}; key refused: ${h.unauthorized}`);
  if (h.logged.finder) {
    L.push(`  email finder calls logged: ${h.logged.finder}, timed out ${h.logged.finderTimeouts}, backed off ${h.logged.backoffs}`
      + `; answered in p50 ${h.logged.p50}ms, p90 ${h.logged.p90}ms, max ${h.logged.max}ms`);
  } else {
    L.push('  no call log for this night (hunter_call_log starts with this change); the next night prints each call\'s time');
  }
  return L.join('\n');
}

async function run(pool, opts = {}) { return build(await gather(pool, opts), opts); }

module.exports = { makespan, simulate, gather, build, format, run, hm };
