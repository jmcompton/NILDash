'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/marketpools.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── EVERY ATHLETE MARKET HAS A POOL, SCANNED OR NOT ─────────────────────────
// market_business_seen filled only when a person ran Deal Scan; a market nobody
// scanned had no pool and the nightly job had nothing to select from. The
// scheduled build (services/marketPools) lists every athlete market, counts
// usable rows, and builds empty, thin and stale markets from Places.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const MP = require(REPO + 'server/services/marketPools.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

// Stub market resolution: the athlete's data carries the market directly.
const resolve = async (r) => ({ profile: { marketKey: r.data.mk || null, market: r.data.region || null, school: r.data.school || null,
  athleteType: r.data.athleteType, localLaneNote: r.data.mk ? null : 'No school on file' } });
// Stub Places: N businesses per ring, all distinct, named by market and ring.
function fakeBuild(perRadius, log) {
  return async (query, opts) => {
    log.push({ query, radius: opts.radiusM, source: opts.source });
    const n = perRadius(opts.radiusM, query);
    if (n < 0) return { ok: false, reason: 'nearby_failed: 403 PERMISSION_DENIED', placesCalls: 3, candidates: [] };
    const cats = ['restaurant', 'gym', 'salon', 'auto', 'retail'];
    return { ok: true, placesCalls: 30, candidates: Array.from({ length: n }, (_, i) => ({ name: `MP ${query} Biz ${i}`, category: cats[i % 5], market: 'school' })) };
  };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await MP.ensureTables(P);
  const AG = 'mp-agent', AG2 = 'mp-agent-2';
  const KEYS = ['mp town a, st', 'mp town b, st', 'mp town c, st', 'mp town p, st'];
  const clean = async () => {
    await P.query(`DELETE FROM athletes WHERE agent_id = ANY($1)`, [[AG, AG2]]);
    await P.query(`DELETE FROM users WHERE id = ANY($1)`, [[AG, AG2]]);
    await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1)`, [KEYS]);
    await P.query(`DELETE FROM market_pool_schedule WHERE market_key = ANY($1)`, [KEYS]);
  };
  await clean();
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1,'Mp Agent','mp@x.test','x','agent'), ($2,'Mp Two','mp2@x.test','x','agent')`, [AG, AG2]);
  const ath = (id, ag, data) => P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1,$2,$3)`, [id, ag, data]);
  // Town A: two athletes, two agents, never scanned. Town B: a scanned but thin
  // pool. Town C: a full pool. Town P: a pro only. One athlete with no market.
  await ath('mp-1', AG, { name: 'Mp One', mk: KEYS[0], region: 'Mp Town A, ST', school: 'Mp State A' });
  await ath('mp-2', AG2, { name: 'Mp Two', mk: KEYS[0], region: 'Mp Town A, ST', school: 'Mp State A' });
  await ath('mp-3', AG, { name: 'Mp Three', mk: KEYS[1], region: 'Mp Town B, ST', school: 'Mp State B' });
  await ath('mp-4', AG, { name: 'Mp Four', mk: KEYS[2], region: 'Mp Town C, ST', school: 'Mp State C' });
  await ath('mp-5', AG, { name: 'Mp Pro', mk: KEYS[3], region: 'Mp Town P, ST', athleteType: 'pro' });
  await ath('mp-6', AG, { name: 'Mp Nowhere' });
  const seed = (key, n, prefix) => P.query(`INSERT INTO market_business_seen (market_key, brand, category)
    SELECT $1, $3 || g, 'restaurant' FROM generate_series(1, $2) g`, [key, n, prefix]);
  await seed(KEYS[1], 40, 'MP B Old ');
  await seed(KEYS[2], 200, 'MP C Old ');
  // A restricted row and a collective do not count as usable.
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1,'Mp Brewing Co','bar'), ($1,'Mp NIL Fund','nonprofit')`, [KEYS[1]]);

  // ── 1. THE REPORT ─────────────────────────────────────────────────────────
  OUT.push('-- the report: every market, and which have nothing --');
  const scope = async (res) => ({ ...res, plan: res.plan.filter((p) => KEYS.includes(p.key)) });
  const rep = await scope(await MP.run(P, { resolve }));
  const byKey = (res, k) => res.plan.find((p) => p.key === k);
  ok('a never-scanned market is EMPTY and due', byKey(rep, KEYS[0]).status === 'empty' && byKey(rep, KEYS[0]).due, byKey(rep, KEYS[0]));
  ok('  one row a market, however many athletes and agents share it', rep.plan.filter((p) => p.key === KEYS[0]).length === 1
    && byKey(rep, KEYS[0]).athletes.length === 2 && byKey(rep, KEYS[0]).agents.length === 2);
  ok('a scanned but thin market is THIN and due, counting only usable rows (40, not 42)', byKey(rep, KEYS[1]).status === 'thin' && byKey(rep, KEYS[1]).usable === 40
    && byKey(rep, KEYS[1]).rows === 42, byKey(rep, KEYS[1]));
  ok('a full, recent market is OK and not due', byKey(rep, KEYS[2]).status === 'ok' && !byKey(rep, KEYS[2]).due, byKey(rep, KEYS[2]));
  ok('a pro-only market is counted and not built here', byKey(rep, KEYS[3]).pro && !byKey(rep, KEYS[3]).due);
  ok('an athlete with no market is listed, not dropped', rep.noMarket.some((n) => n.athlete === 'Mp Nowhere'));
  ok('empty first, then thin', rep.plan.findIndex((p) => p.key === KEYS[0]) < rep.plan.findIndex((p) => p.key === KEYS[1]));
  ok('the report is report-only: nothing built', rep.built.length === 0);
  const text = MP.formatReport(rep);
  ok('the report says the distinct markets and the zero-row count', /distinct market\(s\)/.test(text) && /with ZERO usable rows/.test(text), text.slice(0, 300));

  // ── 2. THE BUILD ──────────────────────────────────────────────────────────
  OUT.push('', '-- the build: empty first, widening until the target --');
  const log = [];
  // Town A: 90 at 8 km, 170 at 16 km. Town B: 60 at every ring (a small town).
  const build = fakeBuild((r, q) => (q === 'Mp State A' ? (r >= 16000 ? 170 : 90) : 60), log);
  const res = await MP.run(P, { resolve, build, apply: true, keys: KEYS });
  const a = res.built.find((b) => b.key === KEYS[0]), b = res.built.find((x) => x.key === KEYS[1]);
  ok('town A was built from Places with the school as the query', a && log.some((l) => l.query === 'Mp State A' && l.source === 'pool-schedule'));
  ok('  8 km gave 90, so it widened to 16 km and reached the target', a && a.steps.map((s) => s.radius).join() === '8000,16000' && a.reached && a.usable >= 150, a);
  const rowsA = (await P.query(`SELECT COUNT(*)::int n FROM market_business_seen WHERE market_key = $1`, [KEYS[0]])).rows[0].n;
  ok('  and the rows are under the key the Scout reads', rowsA === 170, rowsA);
  ok('town B widened to the widest ring and stayed thin: reported, not hidden', b && b.steps.length === MP.RADII.length && !b.reached, b);
  ok('town C (full) and the pro market were not built', !res.built.some((x) => x.key === KEYS[2] || x.key === KEYS[3]));
  const s = (await P.query(`SELECT * FROM market_pool_schedule WHERE market_key = ANY($1) ORDER BY market_key`, [KEYS])).rows;
  ok('every build is on market_pool_schedule with its ring and usable count', s.length === 2 && s[0].usable >= 150 && s[1].radius_m === MP.RADII[MP.RADII.length - 1], s);

  const again = await scope(await MP.run(P, { resolve, keys: KEYS }));
  ok('the next night: A is ok, B is small at the widest ring and waits THIN_RETRY_DAYS', byKey(again, KEYS[0]).status === 'ok'
    && byKey(again, KEYS[1]).status === 'thin' && !byKey(again, KEYS[1]).due, [byKey(again, KEYS[0]), byKey(again, KEYS[1])]);
  const later = await scope(await MP.run(P, { resolve, keys: KEYS, now: Date.now() + (MP.REFRESH_DAYS + 1) * 86400000 }));
  ok('after REFRESH_DAYS a full market is STALE and due again', byKey(later, KEYS[0]).status === 'stale' && byKey(later, KEYS[0]).due);

  // ── 3. LIMITS AND FAILURES ────────────────────────────────────────────────
  OUT.push('', '-- limits and failures --');
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [KEYS[0]]);
  await P.query(`DELETE FROM market_pool_schedule WHERE market_key = $1`, [KEYS[0]]);
  const flog = [];
  const failed = await MP.run(P, { resolve, apply: true, keys: KEYS, build: fakeBuild(() => -1, flog) });
  const fa = failed.built.find((x) => x.key === KEYS[0]);
  ok('a failed build is recorded as failed with Google\'s reason, and does not widen', fa && !fa.ok && /PERMISSION_DENIED/.test(fa.reason) && fa.steps.length === 1, fa);
  const fs1 = (await P.query(`SELECT last_ok, last_reason FROM market_pool_schedule WHERE market_key = $1`, [KEYS[0]])).rows[0];
  ok('  and the market stays EMPTY and due tomorrow', fs1.last_ok === false && byKey(await scope(await MP.run(P, { resolve, keys: KEYS })), KEYS[0]).due);
  const capped = await MP.run(P, { resolve, apply: true, keys: KEYS, maxMarkets: 0, build: fakeBuild(() => 200, []) });
  ok('the run stops at its market limit and says so', capped.built.length === 0 && /market limit/.test(capped.stop), capped.stop);
  const callCap = await MP.run(P, { resolve, apply: true, keys: KEYS, maxCalls: 1, build: fakeBuild(() => 60, []) });
  ok('  and at its Places request limit', /request limit/.test(callCap.stop) || callCap.built.every((x) => x.calls <= 30), callCap.stop);

  // ── 4. THE SCHEDULE ───────────────────────────────────────────────────────
  OUT.push('', '-- the schedule --');
  const noon = new Date('2026-09-30T17:00:00Z').getTime();       // noon Central
  const tenPm = new Date('2026-10-01T03:30:00Z').getTime();      // 10:30pm Central, Sept 30
  ok('the tick does nothing outside 10pm-midnight Central', (await MP.tick(P, { force: false, now: noon, resolve })).ran === false);
  const IDX = read('server/index.js');
  ok('the server schedules it every 15 minutes, before the nightly fill', /MP\.tick\(store\.pool\)/.test(IDX) && MP.WINDOW_END_HOUR <= 24 && MP.WINDOW_START_HOUR >= 20);
  ok('  and the admin runner has the report', /'market-pools': \{ file: 'scripts\/market-pools\.js'/.test(IDX));
  await P.query(`DELETE FROM market_pool_runs WHERE run_date = '2026-09-30'`);
  const prev = process.env.GOOGLE_PLACES_API_KEY; process.env.GOOGLE_PLACES_API_KEY = 'test-key';
  const t1 = await MP.tick(P, { now: tenPm, resolve, build: fakeBuild(() => 200, []), keys: KEYS });
  const t2 = await MP.tick(P, { now: tenPm + 900000, resolve, build: fakeBuild(() => 200, []), keys: KEYS });
  if (prev === undefined) delete process.env.GOOGLE_PLACES_API_KEY; else process.env.GOOGLE_PLACES_API_KEY = prev;
  ok('inside the window it runs once for the date', t1.ran === true && t2.ran === false && /already ran/.test(t2.why), [t1, t2]);
  const runRow = (await P.query(`SELECT summary FROM market_pool_runs WHERE run_date = '2026-09-30'`)).rows[0];
  ok('  and records what it did', runRow && runRow.summary && typeof runRow.summary.builtMarkets === 'number', runRow);
  await P.query(`DELETE FROM market_pool_runs WHERE run_date = '2026-09-30'`);
  ok('placesMarket takes a radius', /opts\.radiusM/.test(read('server/services/placesMarket.js')));

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
