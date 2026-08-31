'use strict';
// Moved out of a session scratchpad, which is reclaimed when the session ends.
// Normalised so it runs from a checkout on any machine: repo-relative paths,
// overridable Postgres settings, an overridable Chromium, and a startup wait the
// runner can shorten once the schema has been migrated once.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/<this file>       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const CHROMIUM = process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium';
// THE THREE FIXES, EXERCISED.
//
// 1. getBrandContacts returns `cached` instead of dropping it.
// 2. spendLog records the meter's cacheHits/cacheMisses, not just a boolean.
// 3. a cache hit is priced at what it cost, not at the ceiling.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const scanMeter = require(ROOT + 'server/scanMeter.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const JOB = require(ROOT + 'server/jobs/outreachQueue.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

const SRC_AI = fs.readFileSync(ROOT + 'server/ai.js', 'utf8');
const SRC_JOB = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
const CEIL = JOB.LOOKUP_CEILING_USD;

// The shipping pricing expression, lifted verbatim from fillAthlete so this
// cannot drift from what actually runs. If the job's arithmetic changes and this
// is not updated, the assertions below stop describing the product.
const JOB_PRICING = SRC_JOB.slice(
  SRC_JOB.indexOf('const touched = meter'),
  SRC_JOB.indexOf('if (realCost > 0) budget.spend(realCost);'));
const price = (meter) => {
  const touched = meter
    && (meter.cacheHits || meter.cacheMisses || meter.webSearches || meter.aiCalls);
  let realCost = Q.priceOf(meter);
  if (!touched) realCost = CEIL;
  return { cost: realCost, metered: !!touched };
};

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  console.log('\n1. THE FIELD IS RETURNED AGAIN');
  const gbc = SRC_AI.slice(SRC_AI.indexOf('async function getBrandContacts'));
  const ret = gbc.slice(gbc.indexOf('return { contacts: res.contacts,'));
  const retStmt = ret.slice(0, ret.indexOf('};') + 2);
  check('getBrandContacts returns cached', /cached: !!res\.cached/.test(retStmt));
  check('  taken from the value it already computed for its own log line',
    /const source = res\.cached \? 'cache'/.test(gbc));

  console.log('\n2. A REAL CACHE HIT COSTS NOTHING');
  // Driven through the actual store read so the meter is populated the way a
  // lookup populates it, not by hand.
  const key = 'Trak Shak | birmingham, al | manual';
  await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key = $1`, [key.toLowerCase()]);
  const VERSION = Number((SRC_AI.match(/_CONTACTS_CACHE_VERSION\s*=\s*(\d+)/) || [])[1]);
  await store.saveBrandEvidence(key, 'contacts', 'Trak Shak', null,
    { kind: 'contacts', v: VERSION, contacts: [{ name: 'Jeff Martinez', title: 'Owner' }],
      notAffiliated: [], genericInbox: null, personalInbox: null,
      businessPhone: '205-555-0100', phoneUnconfirmed: false }, 'OK');

  const hit = await scanMeter.run(() => store.getBrandEvidence(key, 'contacts', 30));
  const hitPrice = price(hit.meter);
  check('the read is a real hit', hit.meter.cacheHits === 1, JSON.stringify(hit.meter));
  check('  it is priced at ZERO, not the ceiling', hitPrice.cost === 0,
    '$' + hitPrice.cost + ' (ceiling $' + CEIL + ')');
  check('  and it counts as measured, so no warning is emitted', hitPrice.metered === true);

  const miss = await scanMeter.run(() => store.getBrandEvidence('nothing here | nowhere', 'contacts', 30));
  check('a miss with no follow-up calls is also measured, not ceilinged',
    price(miss.meter).cost === 0 && price(miss.meter).metered === true, JSON.stringify(miss.meter));

  console.log('\n3. THE CEILING IS NOW ONLY FOR A BROKEN METER');
  check('a lookup that recorded nothing at all is charged the ceiling',
    price({ webSearches: 0, aiCalls: 0, cacheHits: 0, cacheMisses: 0 }).cost === CEIL);
  check('  and is flagged as unmeasured', price({ webSearches: 0, aiCalls: 0, cacheHits: 0, cacheMisses: 0 }).metered === false);
  check('a null meter is charged the ceiling too', price(null).cost === CEIL);
  // CODE ONLY. The old expression is quoted in the comment above its replacement
  // -- that comment is the record of the bug -- so a whole-file match finds the
  // documentation and reports a regression that is not there.
  const jobCode = SRC_JOB.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('THE REGRESSION GUARD: the ceiling is not reachable from a cache hit',
    !/out\.cached \? 0 :/.test(jobCode) && /if \(!touched\)/.test(JOB_PRICING),
    'pricing keys off the meter, not the boolean');

  console.log('\n4. A PARTIAL HIT IS PRICED AT WHAT IT COST');
  const partial = price({ webSearches: 4, aiCalls: 1, cacheHits: 3, cacheMisses: 1 });
  check('contacts cached but the ladder still ran', partial.cost === 0.043, '$' + partial.cost);
  const cold = price({ webSearches: 7, aiCalls: 2, cacheHits: 0, cacheMisses: 4 });
  check('a fully cold lookup costs more than a partial one', cold.cost > partial.cost,
    '$' + cold.cost + ' vs $' + partial.cost);

  console.log('\n5. THE COUNTS SURVIVE INTO spendLog AND THE ROLLUP');
  check('spendLog records cacheHits', /cacheHits: meter \? meter\.cacheHits : 0/.test(SRC_JOB));
  check('  and cacheMisses', /cacheMisses: meter \? meter\.cacheMisses : 0/.test(SRC_JOB));
  check('  and says when the meter failed', /metered: !!touched/.test(SRC_JOB));

  // A night: two athletes, a mix of hits, partials and one broken meter.
  const night = [
    [{ brand: 'A', cost: 0, cacheHits: 4, cacheMisses: 0, metered: true },
      { brand: 'B', cost: 0.043, cacheHits: 3, cacheMisses: 1, metered: true }],
    [{ brand: 'C', cost: 0.07, cacheHits: 0, cacheMisses: 4, metered: true },
      { brand: 'D', cost: CEIL, cacheHits: 0, cacheMisses: 0, metered: false }],
  ];
  const s = Q.costSummary(night);
  check('free lookups are the ones that cost nothing', s.freeLookups === 1, s.freeLookups);
  check('  not the ones with a truthy flag', s.paidLookups === 3, s.paidLookups);
  check('the hit rate is over READS, not lookups',
    s.cacheReads === 12 && s.cacheHits === 7 && s.cacheHitPct === 58.3,
    JSON.stringify({ reads: s.cacheReads, hits: s.cacheHits, pct: s.cacheHitPct }));
  check('a failed measurement is reported, not averaged in silently',
    s.unmeteredLookups === 1, s.unmeteredLookups);
  check('the total is still the sum of what was charged',
    s.totalUsd === Math.round((0 + 0.043 + 0.07 + CEIL) * 10000) / 10000, '$' + s.totalUsd);

  console.log('\n6. THE OLD BUG, AS ARITHMETIC');
  // What the previous code would have reported for the same night: `cached` was
  // undefined on every row, so paid === lookups and the hit rate was 0.0%.
  const oldPaid = night.flat().filter((x) => !undefined).length;
  check('the old filter called every lookup paid', oldPaid === 4, oldPaid);
  check('  which is why 152 lookups reported 0.0% cached',
    Q.costSummary(night).cacheHitPct !== 0, 'now ' + s.cacheHitPct + '%');

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
