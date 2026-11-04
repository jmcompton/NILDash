'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/firstfill.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A NEW ATHLETE'S FIRST CARDS DO NOT WAIT FOR TONIGHT ─────────────────────
// Nov 2026: athletes added at schools nobody had used (Morningside, CSU
// Bakersfield, Grand Valley State) got no cards the day they were added: the
// town had no business list until the 10pm build, and the on-demand fill runs
// on $0.15 without widening. Adding an athlete now builds his town first when
// it is thin, and the first fill gets a real budget and may widen.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const MP = require(REPO + 'server/services/marketPools.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

const resolve = async (r) => ({ profile: { marketKey: r.data.mk || null, market: r.data.region || null, school: r.data.school || null, athleteType: r.data.athleteType } });
function fakeBuild(n, log) {
  return async (query, opts) => {
    log.push({ query, radius: opts.radiusM });
    const cats = ['restaurant', 'gym', 'salon', 'auto', 'retail'];
    return { ok: true, placesCalls: 30, candidates: Array.from({ length: n }, (_, i) => ({ name: `FF ${query} ${opts.radiusM} Biz ${i}`, category: cats[i % 5], market: 'school' })) };
  };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await MP.ensureTables(P);
  const KEYS = ['ff town a, st', 'ff town b, st', 'ff town p, st'];
  const clean = async () => {
    await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1)`, [KEYS]);
    await P.query(`DELETE FROM market_pool_schedule WHERE market_key = ANY($1)`, [KEYS]);
  };
  await clean();
  const athA = { id: 'ff-1', data: { name: 'Ff One', mk: KEYS[0], region: 'Ff Town A, ST', school: 'Ff State A' } };
  const athB = { id: 'ff-2', data: { name: 'Ff Two', mk: KEYS[1], region: 'Ff Town B, ST', school: 'Ff State B' } };
  const athP = { id: 'ff-3', data: { name: 'Ff Pro', mk: KEYS[2], region: 'Ff Town P, ST', athleteType: 'pro' } };
  const athN = { id: 'ff-4', data: { name: 'Ff Nowhere' } };
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) SELECT $1, 'FF B Old ' || g, 'restaurant' FROM generate_series(1, $2) g`, [KEYS[1], MP.FIRST_FLOOR + 5]);

  OUT.push('-- the new athlete\'s town --');
  const log = [];
  const a = await MP.ensureForAthlete(P, athA, { resolve, build: fakeBuild(60, log), force: true });
  ok('an empty town is built now, from the school', a.built && log.length >= 1 && log[0].query === 'Ff State A', { a, log });
  ok('  and its businesses land under the athlete\'s market key', a.usable >= 60, a);
  const sched = (await P.query(`SELECT builds, usable FROM market_pool_schedule WHERE market_key = $1`, [KEYS[0]])).rows[0];
  ok('  on the same schedule row the nightly build keeps', sched && sched.builds === 1, sched);
  const log2 = [];
  const a2 = await MP.ensureForAthlete(P, athA, { resolve, build: fakeBuild(60, log2), force: true });
  ok('a town built once is not built again for the next athlete', !a2.built && log2.length === 0, a2);
  const log3 = [];
  const b = await MP.ensureForAthlete(P, athB, { resolve, build: fakeBuild(60, log3), force: true });
  ok('a town that already has a list costs nothing', !b.built && log3.length === 0 && /already has/.test(b.why), b);
  const log4 = [];
  const p = await MP.ensureForAthlete(P, athP, { resolve, build: fakeBuild(60, log4), force: true });
  ok('a pro is left to the pro passes', !p.built && log4.length === 0 && /pro/.test(p.why), p);
  const n = await MP.ensureForAthlete(P, athN, { resolve, build: fakeBuild(60, []), force: true });
  ok('an athlete with no market is reported, nothing built', !n.built && n.why === 'no market', n);
  const saved = process.env.MARKET_POOL_SCHEDULE; process.env.MARKET_POOL_SCHEDULE = 'off';
  const off = await MP.ensureForAthlete(P, athA, { resolve, build: fakeBuild(60, []) });
  process.env.MARKET_POOL_SCHEDULE = saved === undefined ? '' : saved; if (saved === undefined) delete process.env.MARKET_POOL_SCHEDULE;
  ok('with Places off, nothing is built', !off.built, off);

  OUT.push('', '-- the wiring --');
  const ac = read('server/services/athleteCreate.js');
  ok('adding an athlete starts a FIRST fill', /runOnDemandFill\(user\.id, id, \{ firstFill: true \}\)/.test(ac));
  ok('  which builds the town before filling', /opts\.firstFill[\s\S]{0,200}ensureForAthlete[\s\S]{0,600}fillOnDemand\(store\.pool, ath, opts\.firstFill \? \{ firstFill: true \} : \{\}\)/.test(ac));
  ok('  and a town build that fails still fills', /town build failed/.test(ac));
  const oq = read('server/jobs/outreachQueue.js');
  ok('the first fill gets the first-fill budget', /Q\.newBudget\(opts\.firstFill \? Math\.max\(FIRST_FILL_USD, ONDEMAND_CAP_USD\) : ONDEMAND_CAP_USD\)/.test(oq));
  ok('  and may widen; every other on-demand fill still never widens', /noWiden: !opts\.firstFill/.test(oq));
  const OQ = require(REPO + 'server/jobs/outreachQueue.js');
  ok('  the first-fill budget is $1 by default', OQ.FIRST_FILL_USD === 1);
  const idx = read('server/index.js');
  ok('the admin fill button passes the agent\'s first name and the athlete row', /agentFirstName, athleteRow: qRow\.data \|\| null/.test(idx));

  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
