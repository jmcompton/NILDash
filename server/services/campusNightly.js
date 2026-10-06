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
// Which universities: every one with teams and a business list (a built
// local pool); see universitiesDue. Once per Central date, in the window below; a restart
// inside the window does not run it twice (university_market_runs 'nightly').
//
//   POST /api/admin/campus/:universityId/nightly   run one now (admin)
const WINDOW_START_HOUR = parseInt(process.env.UNIVERSITY_NIGHT_START_HOUR_CT, 10) || 1;   // 1am Central = 11pm Pacific
const WINDOW_END_HOUR = parseInt(process.env.UNIVERSITY_NIGHT_END_HOUR_CT, 10) || 5;
const PER_TEAM = 5;
// ── THE WHOLE NIGHT HAS ONE CAP ─────────────────────────────────────────────
// Each team stops at its own ceiling (teamScan UNIVERSITY_TEAM_COST_CEILING_USD,
// $1.50: contact lookups and the writer). That alone let fifteen teams spend
// fifteen ceilings, and Places builds were outside every ceiling. Now the
// night has one: Places included, every team's ceiling is the smaller of its
// own and what is left, and a team that would start with too little left does
// not start (it is reported short, 'night-cap').
// HARD $5. The setting can lower it, never raise it: a university night is
// a team-level pass over a list already built and resolved, and $5 covers
// it with room to spare (estimate() below shows the arithmetic).
const NIGHT_HARD_CAP_USD = 5;
const NIGHT_CAP_USD = Math.min(NIGHT_HARD_CAP_USD, parseFloat(process.env.UNIVERSITY_NIGHT_COST_CEILING_USD) || NIGHT_HARD_CAP_USD);
const TEAM_CAP_USD = parseFloat(process.env.UNIVERSITY_TEAM_COST_CEILING_USD) || 1.50;
// A wider ring is one Places build: up to 30 types x 5 calls. Only started
// when the night can still afford the worst case.
const RING_WORST_USD = 30 * 5 * (parseFloat(process.env.USD_PER_PLACES_REQUEST) || 0.032);
const _running = new Set();

function centralNow(now = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit' })
    .formatToParts(now).reduce((o, x) => { o[x.type] = x.value; return o; }, {});
  return { date: `${p.year}-${p.month}-${p.day}`, hour: parseInt(p.hour, 10) % 24 };
}

// Every department with staff and teams. It used to require a reachable
// contact already on file, which only a bulk contact build produced; the night
// finds and resolves the contacts for the businesses it picks, like the
// agents' night, so a department without one never started.
// THE CARDS NEED TEAMS AND A BUSINESS LIST, nothing else: a university with
// teams and a built local pool is run whether or not its staff have signed in
// yet, so the first login finds a morning of cards. Nothing is sent by the
// night: every card is a draft.
async function universitiesDue(pool) {
  const unis = (await pool.query(
    `SELECT u.id, u.location FROM universities u
      WHERE EXISTS (SELECT 1 FROM university_teams t WHERE t.university_id = u.id)`)).rows;
  const CP = require('./campusPool');
  const out = [];
  for (const u of unis) {
    const full = await CP.universityOf(pool, u.id).catch(() => null);
    if (!full || !full.marketKey) continue;
    const n = (await pool.query(`SELECT COUNT(*)::int n FROM university_market_seen WHERE market_key = $1 AND blocked_reason IS NULL`, [full.marketKey]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
    if (n > 0) out.push(u.id);
  }
  return out;
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
    // WHAT TONIGHT WILL COST, before a cent is spent: logged, and stored on
    // the run so the morning can compare it with what it did spend.
    const projected = await estimate(pool, universityId).catch((e) => ({ ok: false, error: e.message }));
    if (projected.ok) console.log(`[campus-nightly] ${universityId} ${night} PROJECTED: ` + formatEstimate(projected).split('\n').join(' | '));
    const run = (await pool.query(`INSERT INTO university_market_runs (university_id, kind, summary) VALUES ($1,'nightly',$2) RETURNING id`,
      [universityId, { night, started: true, projected }])).rows[0].id;
    const sorted = (await pool.query(`SELECT id, name FROM university_teams WHERE university_id = $1 ORDER BY name`, [universityId])).rows;
    // The first team starts one later each night, so a night that hits its
    // cap shorts a different team each time, never the end of the alphabet.
    const day = Math.floor(Date.parse(night + 'T12:00:00Z') / 86400000) || 0;
    const k = sorted.length ? day % sorted.length : 0;
    const teams = sorted.slice(k).concat(sorted.slice(0, k));
    const out = [];
    const Q = require('./outreachQueue');
    const nightCap = Math.min(NIGHT_HARD_CAP_USD, Number(deps.nightCapUsd) > 0 ? Number(deps.nightCapUsd) : NIGHT_CAP_USD);
    let teamSpend = 0;
    const shared = { built: false, rings: new Set(), placesCalls: 0 };
    const spent = () => teamSpend + shared.placesCalls * Q.USD_PER_PLACES_REQUEST;
    shared.canWiden = () => nightCap - spent() >= RING_WORST_USD;
    for (const t of teams) {
      let r;
      const left = nightCap - spent();
      // Too little left for a team to place even one card (a contact lookup
      // and the writer): it does not start, and is reported short.
      if (left < 0.25) {
        out.push({ team: t.name, teamId: t.id, ok: false, cards: 0, error: null, stop: 'night-cap', rungs: [], candidates: 0, costUsd: 0 });
        continue;
      }
      try {
        // NO PLACES AT NIGHT. The business list is built (campusBuild); the
        // night reads it. It used to open with a full Places sweep of the
        // campus (30 to 150 calls, $0.96 to $4.80) every single night.
        r = await TS.runTeamScan(pool, { universityId, teamId: t.id, limit: PER_TEAM, mode: 'pitch', discoverPool: deps.discoverPool === true,
          deps: { ...deps, nightShare: shared, costCeilingUsd: Math.min(Number(deps.costCeilingUsd) > 0 ? Number(deps.costCeilingUsd) : TEAM_CAP_USD, left) } });
        teamSpend += (r.loop && Number(r.loop.costUsd)) || 0;
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
      // The whole night, Places included, against its one cap.
      costUsd: Math.round(spent() * 1000) / 1000, teamUsd: Math.round(teamSpend * 1000) / 1000, projected,
      placesCalls: shared.placesCalls, placesUsd: Math.round(shared.placesCalls * Q.USD_PER_PLACES_REQUEST * 1000) / 1000,
      nightCapUsd: nightCap, perTeam: out };
    await pool.query(`UPDATE university_market_runs SET finished_at = NOW(), summary = $2 WHERE id = $1`, [run, summary]);
    console.log(`[campus-nightly] ${universityId} ${night}: ${summary.cards} of ${summary.target} cards, $${summary.costUsd}`
      + (short.length ? `; SHORT: ${short.map((x) => `${x.team} ${x.cards}`).join(', ')}` : ''));
    return { ok: true, ...summary };
  } finally {
    _running.delete(universityId);
  }
}

// ── WHAT ONE NIGHT WILL COST, BEFORE IT RUNS (spends nothing) ───────────────
// The night writes PER_TEAM cards a team. A card is the written email
// (USD_PER_AI_CALL) plus, only when the business has no named contact on file
// yet, a contact lookup (campusContacts.perBusinessUsd: cheap path to dear
// path, and the dear case assumes half the lookups find nobody). No Places:
// the night reads the built list. Cards come first from businesses whose
// named contact is already on file and is not resting (pitched in the last
// PITCH_REST_DAYS), so lookups are bought only for the shortfall. The night
// stops at its cap whatever the parts add up to.
async function estimate(pool, universityId) {
  const Q = require('./outreachQueue');
  const CC = require('./campusContacts');
  const TS = require('./teamScan');
  const CP = require('./campusPool');
  const u = await CP.universityOf(pool, universityId);
  if (!u) return { ok: false, error: `no university "${universityId}"` };
  const teams = (await pool.query(`SELECT COUNT(*)::int n FROM university_teams WHERE university_id = $1`, [universityId])).rows[0].n;
  const ready = (await pool.query(
    `SELECT COUNT(*)::int n FROM university_contacts c
       JOIN university_market_seen m ON m.market_key = $2 AND m.brand = c.brand AND m.blocked_reason IS NULL
      WHERE c.university_id = $1 AND c.reachable
        AND NOT EXISTS (SELECT 1 FROM university_drafts d WHERE d.university_id = $1 AND d.brand_name = c.brand AND d.kind = 'pitch'
                          AND d.created_at > NOW() - make_interval(days => $3))
        AND NOT EXISTS (SELECT 1 FROM university_touches t WHERE t.university_id = $1 AND t.brand = c.brand)`,
    [universityId, u.marketKey, TS.PITCH_REST_DAYS]).catch(() => ({ rows: [{ n: 0 }] }))).rows[0].n;
  const known = (await pool.query(`SELECT COUNT(*) FILTER (WHERE reachable)::int AS reachable, COUNT(*)::int AS n FROM university_contacts WHERE university_id = $1`, [universityId])).rows[0];
  const per = { low: CC.perBusinessUsd('low', false).metered, high: CC.perBusinessUsd('high', false).metered };
  const cards = teams * PER_TEAM;
  const fromFile = Math.min(ready, cards);
  const lookups = cards - fromFile;
  const r2 = (x) => Math.round(x * 100) / 100;
  const writer = cards * Q.USD_PER_AI_CALL;
  const low = r2(writer + lookups * per.low);
  const high = r2(writer + lookups * 2 * per.high);
  return { ok: true, university: u.name, teams, perTeamTarget: PER_TEAM, cards, readyContacts: ready, cardsFromFile: fromFile, lookupsNeeded: lookups,
    perContactLookupUsd: [per.low, per.high], writerUsd: r2(writer), placesUsd: 0,
    uncappedUsd: [low, high], totalUsd: [Math.min(low, NIGHT_CAP_USD), Math.min(high, NIGHT_CAP_USD)],
    teamCapUsd: TEAM_CAP_USD, nightCapUsd: NIGHT_CAP_USD, contactsOnFile: known,
    shortfallLikely: high > NIGHT_CAP_USD };
}

function formatEstimate(e) {
  if (!e || !e.ok) return (e && e.error) || 'no estimate';
  const usd = (a) => `$${a[0].toFixed(2)} to $${a[1].toFixed(2)}`;
  return [
    `TONIGHT FOR ${e.university}: ${e.teams} teams x ${e.perTeamTarget} cards = ${e.cards} cards`,
    `  named contacts on file, ready to pitch: ${e.readyContacts}  -> ${e.cardsFromFile} cards need no lookup ($${(e.cardsFromFile * 0.003).toFixed(2)} of writing)`,
    `  contact lookups needed: ${e.lookupsNeeded} at ${usd(e.perContactLookupUsd)} each`,
    `  Places: $0 (the night reads the built list)`,
    `PROJECTED: ${usd(e.totalUsd)}${e.uncappedUsd[1] > e.nightCapUsd ? ` (uncapped ${usd(e.uncappedUsd)})` : ''}`,
    `HARD CAP: $${e.nightCapUsd.toFixed(2)} for the whole night` + (e.shortfallLikely ? `; at the dear end it stops at the cap and the last teams in tonight's rotation come up short` : ''),
  ].join('\n');
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

module.exports = { runNight, tick, centralNow, universitiesDue, ranTonight, estimate, formatEstimate, PER_TEAM, WINDOW_START_HOUR, WINDOW_END_HOUR, NIGHT_CAP_USD, NIGHT_HARD_CAP_USD, TEAM_CAP_USD, RING_WORST_USD };
