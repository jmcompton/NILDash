'use strict';
// Runs from a checkout on any machine: repo-relative paths, overridable
// Postgres settings.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/poolrecord.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

// ── THE WHOLE POOL, NOT THE PAGE ────────────────────────────────────────────
//
// market_business_seen had 20 rows under "fayetteville, ar"; the scan had
// found 241. The only ordinary-scan writer was the Deal Scan route, recording
// the ten businesses it had just paged to the agent. The other 221 sat in
// deal_scan_market_cache, which the nightly local lane never reads, so every
// athlete in that market "exhausted" after twenty.
//
// WHAT THIS SUITE PROTECTS:
//   1. The pool is recorded in full, under the TOWN key the slate reads --
//      school-market candidates under the school town, hometown candidates
//      under the hometown -- not under a school slug and not only the page.
//   2. Placeholder names are still rejected on the way in.
//   3. It is idempotent: recording the same pool twice adds nothing.
//   4. It is wired at the one point in getDealRecommendations where the full
//      pool exists and nothing has been paged off it yet -- after phase 1,
//      before the ledger split. Asserted on the source, because the scan itself
//      needs Places and a model to run.

const { Pool } = require(REPO + 'node_modules/pg');
const store = require(REPO + 'server/store');
const { marketPoolKey } = require(REPO + 'server/services/regionKey');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

const P = new Pool({ max: 3 });
const SCHOOL = 'Fayetteville, AR';
const HOME = 'Bentonville, AR';
const SK = marketPoolKey(SCHOOL), HK = marketPoolKey(HOME);

async function cleanup() {
  await P.query(`DELETE FROM market_business_seen WHERE market_key = ANY($1::text[])`, [[SK, HK]]);
  await P.query(`DELETE FROM market_business_rejected WHERE market_key = ANY($1::text[])`, [[SK, HK]]).catch(() => {});
}
const rows = async (k) => (await P.query(`SELECT brand FROM market_business_seen WHERE market_key=$1 ORDER BY brand`, [k])).rows.map((r) => r.brand);

async function main() {
  await cleanup();
  await new Promise((r) => setTimeout(r, parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000));

  // A pool the way getDealRecommendations builds it: `name`, and `market` says
  // which town each business belongs to.
  const found = [];
  for (let i = 1; i <= 24; i++) found.push({ name: `PR School Biz ${i}`, market: 'school', place_id: 'pid' + i });
  for (let i = 1; i <= 5; i++) found.push({ name: `PR Home Biz ${i}`, market: 'hometown' });
  found.push({ name: 'Core Physical Therapy (or similar local PT/chiro near campus)', market: 'school' }); // placeholder
  found.push({ name: '', market: 'school' });                                                                // blank

  // ── 1. THE WHOLE POOL LANDS, UNDER THE TOWN KEYS ─────────────────────────
  const r1 = await store.recordMarketPool(found, { schoolMarket: SCHOOL, hometown: HOME });
  ok('the school pool is keyed by the school TOWN, not a school slug', r1.schoolKey === 'fayetteville, ar', r1.schoolKey);
  ok('  and the hometown pool by the hometown', r1.hometownKey === 'bentonville, ar', r1.hometownKey);
  const sch = await rows(SK), hom = await rows(HK);
  ok('all 24 school businesses are in the table, not a page of ten', sch.length === 24, sch.length);
  ok('  all 5 hometown businesses under their own key', hom.length === 5, hom.length);
  ok('  and none of them crossed into the other town',
    !sch.some((b) => /Home Biz/.test(b)) && !hom.some((b) => /School Biz/.test(b)), null);

  // ── 2. PLACEHOLDERS STILL REJECTED ───────────────────────────────────────
  ok('a placeholder name is not recorded as a business', !sch.some((b) => /or similar/.test(b)), sch.filter((b) => /similar/.test(b)));
  const rej = await P.query(`SELECT brand FROM market_business_rejected WHERE market_key=$1`, [SK]).catch(() => ({ rows: [] }));
  ok('  and is recorded as rejected, not silently dropped', rej.rows.some((r) => /or similar/.test(r.brand)), rej.rows.map((r) => r.brand));
  ok('a blank name is dropped without error', !sch.includes(''), null);

  // ── 3. IDEMPOTENT ────────────────────────────────────────────────────────
  const before = (await P.query(`SELECT COUNT(*)::int c FROM market_business_seen WHERE market_key = ANY($1::text[])`, [[SK, HK]])).rows[0].c;
  await store.recordMarketPool(found, { schoolMarket: SCHOOL, hometown: HOME });
  const after = (await P.query(`SELECT COUNT(*)::int c FROM market_business_seen WHERE market_key = ANY($1::text[])`, [[SK, HK]])).rows[0].c;
  ok('recording the same pool again adds nothing', before === after && before === 29, { before, after });

  // ── 4. EDGE INPUTS NEVER THROW ───────────────────────────────────────────
  const empty = await store.recordMarketPool([], { schoolMarket: SCHOOL });
  ok('an empty pool records nothing and returns', empty.school === 0 && empty.hometown === 0, empty);
  const noMarket = await store.recordMarketPool(found, {});
  ok('no market strings means no keys and no throw', noMarket.schoolKey === null && noMarket.hometownKey === null, noMarket);
  const bad = await store.recordMarketPool(null, { schoolMarket: SCHOOL });
  ok('a null pool is tolerated', bad && bad.school === 0, bad);
  // A brand-shaped item (from the cache hit path some rows use `brand`) also counts.
  await cleanup();
  const r5 = await store.recordMarketPool([{ brand: 'PR Brand Shaped', market: 'school' }], { schoolMarket: SCHOOL });
  ok('an item carrying `brand` instead of `name` is recorded too', r5.school === 1 && (await rows(SK)).includes('PR Brand Shaped'), r5);

  // ── 5. WIRED WHERE THE FULL POOL EXISTS, BEFORE PAGING ───────────────────
  {
    const fs = require('fs');
    const src = fs.readFileSync(REPO + 'server/ai.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const iRec = src.indexOf('store.recordMarketPool(found');
    const iPage = src.indexOf('const _notRetired = _isManual ? found');
    const iElse = src.indexOf("'Places (no web passes needed)' : 'market cache'");
    ok('getDealRecommendations records the pool', iRec > -1, null);
    ok('  after phase 1 (so a cache hit and a Places pool are both covered)', iElse > -1 && iRec > iElse, { iRec, iElse });
    ok('  and BEFORE the page is cut', iPage > -1 && iRec < iPage, { iRec, iPage });
    ok('  keyed by the school market and the hometown', /recordMarketPool\(found, \{ schoolMarket, hometown:/.test(src), null);
    const st = fs.readFileSync(REPO + 'server/store.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    // ── ANCHORED ON THE CALL, NOT ON ITS ARGUMENT LIST ────────────────────
    // This matched `markMarketNewcomers(sk, school)` literally, so adding the
    // third argument -- the category and evidence the scan already knew, which
    // the table used to drop at the insert -- broke it while the contract it
    // guards was untouched. The contract is: ONE insert into the table, and it
    // goes through the helper that filters placeholder names first. Both still
    // hold, and the meta argument is pinned too so it cannot be quietly dropped
    // and leave every new row uncategorised.
    ok('the helper routes through markMarketNewcomers (placeholder filter + upsert), not a second INSERT',
      (st.match(/INSERT INTO market_business_seen/g) || []).length === 1
      && /await markMarketNewcomers\(sk, school\b/.test(st), null);
    ok('  and hands it the category and evidence the scan found',
      /await markMarketNewcomers\(sk, school, meta\)/.test(st)
      && /await markMarketNewcomers\(hk, home, meta\)/.test(st), null);
  }

  await cleanup();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch(async (e) => { console.error('THREW', e); try { await cleanup(); await P.end(); } catch (_) {} process.exit(1); });
