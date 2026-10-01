'use strict';
// ── A DEPARTMENT'S NIGHT: FIVE CARDS FOR EVERY TEAM ─────────────────────────
//
// Every team gets five cards each morning: a business in town, the named human
// there and how to reach them, the team, why, and a pitch signed by the
// department's sender. One loop per team, the shared one (teamScan, mode
// 'pitch'): never a lower bar, and a team that comes up short is an ourFault
// 'nightly-floor' alert naming the team, the count and the rungs tried, read by
// the morning alert.
//
// Which universities: every one with staff and a worked contact pool
// (university_contacts). Once per Central date, in the window below; a restart
// inside the window does not run it twice (university_market_runs 'nightly').
//
//   POST /api/admin/campus/:universityId/nightly   run one now (admin)
const WINDOW_START_HOUR = parseInt(process.env.UNIVERSITY_NIGHT_START_HOUR_CT, 10) || 1;   // 1am Central = 11pm Pacific
const WINDOW_END_HOUR = parseInt(process.env.UNIVERSITY_NIGHT_END_HOUR_CT, 10) || 5;
const PER_TEAM = 5;
const _running = new Set();

function centralNow(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(now).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}

async function universitiesDue(pool) {
  return (await pool.query(
    `SELECT DISTINCT u.id FROM universities u
       JOIN users s ON s.university_id = u.id AND s.role IN ('university','university_admin')
      WHERE EXISTS (SELECT 1 FROM university_contacts c WHERE c.university_id = u.id AND c.reachable IS TRUE)`)).rows.map((r) => r.id);
}

async function ranTonight(pool, universityId, night) {
  return (await pool.query(`SELECT 1 FROM university_market_runs WHERE university_id = $1 AND kind = 'nightly' AND summary->>'night' = $2`,
    [universityId, night])).rowCount > 0;
}

// One department, every team. deps pass straight to the team loop (tests).
async function runNight(pool, universityId, deps = {}) {
  if (_running.has(universityId)) return { ok: false, error: 'already running' };
  _running.add(universityId);
  try {
    const CP = require('./campusPool');
    const TS = require('./teamScan');
    await CP.ensureTables(pool);
    await TS.ensureTables(pool);
    const night = deps.night || centralNow().date;
    const run = (await pool.query(`INSERT INTO university_market_runs (university_id, kind, summary) VALUES ($1,'nightly',$2) RETURNING id`,
      [universityId, { night, started: true }])).rows[0].id;
    const teams = (await pool.query(`SELECT id, name FROM university_teams WHERE university_id = $1 ORDER BY name`, [universityId])).rows;
    const out = [];
    for (const t of teams) {
      let r;
      try {
        r = await TS.runTeamScan(pool, { universityId, teamId: t.id, limit: PER_TEAM, mode: 'pitch', discoverPool: deps.discoverPool !== false, deps });
      } catch (e) {
        require('./ourFault').record('nightly-floor', `${t.name}: the team's night threw: ${e.message}`, 'campusNightly ' + universityId).catch(() => {});
        r = { ok: false, error: e.message };
      }
      out.push({ team: t.name, teamId: t.id, ok: r.ok, cards: (r.drafts || []).length, error: r.error || null,
        stop: r.loop && r.loop.stop, rungs: r.loop && r.loop.rungs, candidates: r.loop && r.loop.candidates, costUsd: r.loop ? r.loop.costUsd : 0 });
    }
    const short = out.filter((x) => x.cards < PER_TEAM);
    const summary = { night, teams: out.length, cards: out.reduce((s, x) => s + x.cards, 0), target: out.length * PER_TEAM,
      short: short.map((x) => ({ team: x.team, cards: x.cards, stop: x.stop, rungs: x.rungs, error: x.error })),
      costUsd: Math.round(out.reduce((s, x) => s + (Number(x.costUsd) || 0), 0) * 1000) / 1000, perTeam: out };
    await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [run, summary]);
    console.log(`[campus-nightly] ${universityId} ${night}: ${summary.cards} of ${summary.target} cards, $${summary.costUsd}`
      + (short.length ? `; SHORT: ${short.map((x) => `${x.team} ${x.cards}`).join(', ')}` : ''));
    return { ok: true, ...summary };
  } finally {
    _running.delete(universityId);
  }
}

async function tick(pool, now = new Date()) {
  const c = centralNow(now);
  if (c.hour < WINDOW_START_HOUR || c.hour >= WINDOW_END_HOUR) return { ran: [] };
  if (String(process.env.UNIVERSITY_NIGHTLY || 'on').toLowerCase() === 'off') return { ran: [], off: true };
  const ran = [];
  for (const id of await universitiesDue(pool)) {
    if (await ranTonight(pool, id, c.date)) continue;
    ran.push(await runNight(pool, id, { night: c.date }));
  }
  return { ran };
}

module.exports = { runNight, tick, centralNow, universitiesDue, ranTonight, PER_TEAM, WINDOW_START_HOUR, WINDOW_END_HOUR };
