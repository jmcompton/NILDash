'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/nightlyfixes.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── THREE SMALL FIXES AHEAD OF THE NIGHTLY REBUILD ──────────────────────────
// 1. The widen never ran past eight athletes: it came out of the athlete's
//    share of the discovery pot (pot / roster, under $0.25), and the log said
//    "the discovery pot is spent" when it was not.
// 2. The athlete pool read took the same 60 rows by last_seen_at every night.
// 3. /admin/cache-health hard-coded contacts cache version 6; the cache is 8.
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const Scout = require(REPO + 'server/services/scout.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE WIDEN ─────────────────────────────────────────────────────────
  OUT.push('-- the widen runs at any roster size --');
  for (const roster of [3, 8, 30, 36]) {
    const b = Q.newBudget(8, undefined, { rosterSize: roster });
    let widened = 0;
    for (let i = 0; i < roster; i++) {
      b.openFor(roster - i);
      if (b.canSpendWiden(0.25)) { b.spendWiden(0.25); widened++; }
    }
    ok(`roster of ${roster}: every athlete can widen once (${widened})`, widened === roster, { widened, cap: b.widenCap() });
  }
  const g = Q.newBudget(8, undefined, { rosterSize: 30 });
  g.openFor(30);
  ok('Greg Glynn\'s roster of 30: the share is too small for a widen ...', g.canSpendDiscovery(0.25) === false, g.discoveryShareLeft());
  ok('  ... but the widen allowance is not the share', g.canSpendWiden(0.25) === true);
  ok('  and a widen does not eat the discovery share', (g.spendWiden(0.25), g.discoveryShareLeft() > 0.1 && g.discoverySpent() === 0));
  ok('the allowance is still a hard cap', (() => { const b = Q.newBudget(8, undefined, { rosterSize: 2 }); b.spendWiden(0.6); return b.canSpendWiden(0.25) === false; })());
  const why = g.discoveryRefusal(0.25);
  ok('the refusal says it is the athlete\'s share, not "the pot is spent"', /this athlete's discovery share/.test(why) && !/pot is spent/.test(why), why);
  const spent = Q.newBudget(8, 1, { rosterSize: 1 }); spent.openFor(1); spent.spendDiscovery(1);
  ok('  and says the pot is spent only when it is', /the night's discovery pot is spent/.test(spent.discoveryRefusal(0.05)), spent.discoveryRefusal(0.05));
  const JOB = read('server/jobs/outreachQueue.js');
  ok('the widen in the job checks the widen allowance and books to it', /budget\.canSpendWiden\(estimateUsd\)/.test(JOB) && /budget\.spendWiden\(cost\)/.test(JOB)
    && /discoveryRefusal\(estimateUsd\)/.test(JOB));
  ok('  and the run row still counts widen spend as discovery', /budget\.widenSpent \? budget\.widenSpent\(\) : 0/.test(JOB));

  // ── 2. THE POOL READ ROTATES ─────────────────────────────────────────────
  OUT.push('', '-- the athlete pool read rotates and spreads --');
  const T = Scout.SUBJECT_TABLES.athlete;
  ok('the athlete read is no longer by last_seen_at', !/last_seen_at/.test(T.poolOrder), T.poolOrder);
  const MK = 'nf-test-market';
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]);
  const cats = ['restaurant', 'gym', 'salon', 'auto', 'retail'];
  const rows = [];
  for (let i = 0; i < 200; i++) rows.push([MK, `NF Business ${i}`, cats[i % 5]]);
  // One statement, one timestamp: exactly how a scan writes the pool.
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category, last_seen_at)
                 SELECT $1, b, c, NOW() FROM unnest($2::text[], $3::text[]) AS t(b, c)`,
    [MK, rows.map((r) => r[1]), rows.map((r) => r[2])]);
  const readFor = async (ath) => (await P.query(
    `SELECT m.brand, m.category FROM market_business_seen m WHERE m.market_key = $1 AND $2::text IS NOT NULL
      ORDER BY ${T.poolOrder} LIMIT $3`, [MK, ath, 60])).rows;
  const a = await readFor('nf-ath-a'), b2 = await readFor('nf-ath-b');
  ok('the first five read are five different kinds', new Set(a.slice(0, 5).map((r) => r.category)).size === 5, a.slice(0, 5));
  const overlap = a.filter((r) => b2.some((s) => s.brand === r.brand)).length;
  ok(`two athletes in one town read different slices (${overlap} of 60 shared)`, overlap < 40, overlap);
  const again = await readFor('nf-ath-a');
  ok('  and one athlete reads the same slice within a night', again.map((r) => r.brand).join() === a.map((r) => r.brand).join());
  ok('the date is in the shuffle, so the slice moves night to night', /CURRENT_DATE/.test(T.poolOrder));
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]);

  // ── 3. CACHE HEALTH READS THE REAL VERSION ───────────────────────────────
  OUT.push('', '-- /admin/cache-health reads the real version --');
  const ai = require(REPO + 'server/ai.js');
  const AI = read('server/ai.js');
  const m = AI.match(/const _CONTACTS_CACHE_VERSION = (\d+);/);
  ok('ai exports the contacts cache version it writes', m && ai.CONTACTS_CACHE_VERSION === Number(m[1]), ai.CONTACTS_CACHE_VERSION);
  const IDX = read('server/index.js');
  ok('the page reads it rather than a number', /const V = ai\.CONTACTS_CACHE_VERSION;/.test(IDX) && !/const V = \d+;\s+\/\/ _CONTACTS_CACHE_VERSION/.test(IDX));
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
