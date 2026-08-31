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
// IS THE CACHE COLD, OR IS THE FLAG BROKEN?
//
// 152 lookups over 14 nights, spendLog says 0.0% cached. Two candidate causes
// and they need different fixes:
//   (a) the nightly path never hits brand_evidence_cache
//   (b) the `cached` flag on spendLog is never populated
//
// This file settles (b) by execution and narrows (a) as far as it can be
// narrowed without production logs.
const fs = require('fs');
const ROOT = REPO;
const store = require(ROOT + 'server/store.js');
const scanMeter = require(ROOT + 'server/scanMeter.js');
const ai = require(ROOT + 'server/ai.js');
const Q = require(ROOT + 'server/services/outreachQueue.js');
const { canonicalRegion } = require(ROOT + 'server/services/regionKey.js');

const out = [];
const check = (n, c, d) => { out.push({ n, ok: !!c }); console.log((c ? '  PASS  ' : '  FAIL  ') + n + (d !== undefined ? '   ' + d : '')); };

// The exact version the read demands. Read out of the source rather than
// retyped, so a bump cannot quietly invalidate this file's premise.
const SRC_AI = fs.readFileSync(ROOT + 'server/ai.js', 'utf8');
const VERSION = Number((SRC_AI.match(/_CONTACTS_CACHE_VERSION\s*=\s*(\d+)/) || [])[1]);

(async () => {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE CACHE ROW AND THE METER BOTH WORK ──────────────────────────────
  console.log('\n1. THE PLUMBING UNDERNEATH IS FINE');
  const BRAND = 'Trak Shak';
  const REGION = 'Birmingham, AL';
  // The key the nightly path builds. deepContactCtx sets stopAtTier1:true, and
  // _fetchBrandContacts appends " | manual" whenever it is set -- so the queue
  // writes and reads the MANUAL key, not the scan key.
  const key = `${BRAND} | ${canonicalRegion(REGION)} | manual`;
  await P.query(`DELETE FROM brand_evidence_cache WHERE brand_key = $1`, [key.toLowerCase()]);
  await store.saveBrandEvidence(key, 'contacts', BRAND, null,
    { kind: 'contacts', v: VERSION, contacts: [{ name: 'Jeff Martinez', title: 'Owner' }],
      notAffiliated: [], genericInbox: null, personalInbox: null,
      businessPhone: '205-555-0100', phoneUnconfirmed: false }, 'OK');

  const m1 = await scanMeter.run(() => store.getBrandEvidence(key, 'contacts', 30));
  check('a seeded row is READ back', !!m1.result, m1.result ? 'hit' : 'miss');
  check('  and the meter counts it as a hit', m1.meter.cacheHits === 1, JSON.stringify(m1.meter));
  check('  so cache-hit data EXISTS at the moment the cost is priced',
    m1.meter.cacheHits === 1 && m1.meter.cacheMisses === 0, JSON.stringify(m1.meter));

  const m2 = await scanMeter.run(() => store.getBrandEvidence('no such brand | nowhere', 'contacts', 30));
  check('a miss is counted as a miss', m2.meter.cacheMisses === 1 && !m2.result, JSON.stringify(m2.meter));

  // The version gate is a HARD miss, and it is the one thing that would empty
  // the cache overnight for every brand at once.
  await P.query(`UPDATE brand_evidence_cache SET evidence = jsonb_set(evidence,'{v}', to_jsonb($2::int))
                  WHERE brand_key = $1`, [key.toLowerCase(), VERSION - 1]);
  const stale = await store.getBrandEvidence(key, 'contacts', 30);
  check('a row IS still returned by the store read when the version is old',
    !!stale, 'the version gate is applied ABOVE this, in ai._fromCache');
  check('  (so a version bump shows as HIT in the cache log and a miss in behaviour)',
    !!stale && (stale.evidence || {}).v !== VERSION, JSON.stringify((stale.evidence || {}).v));
  await P.query(`UPDATE brand_evidence_cache SET evidence = jsonb_set(evidence,'{v}', to_jsonb($2::int))
                  WHERE brand_key = $1`, [key.toLowerCase(), VERSION]);

  // ── 2. THE FLAG IS DROPPED ON THE WAY OUT ─────────────────────────────────
  console.log('\n2. WHERE THE FLAG GOES MISSING');
  // _fetchBrandContacts returns cached:true on a hit -- both of its cache-hit
  // return paths say so.
  check('_fromCache returns cached: true',
    /return \{ contacts: ev\.contacts[\s\S]{0,400}?cached: true \}/.test(SRC_AI));
  check('the cold path returns cached: false',
    /return \{ contacts: named,[\s\S]{0,300}?outcome, cached: false \}/.test(SRC_AI));

  // ...and getBrandContacts, which is what the nightly job actually calls,
  // rebuilds its result from an explicit field list that omits it.
  const gbc = SRC_AI.slice(SRC_AI.indexOf('async function getBrandContacts'));
  const ret = gbc.slice(gbc.indexOf('return { contacts: res.contacts,'));
  const retStmt = ret.slice(0, ret.indexOf('};') + 2);
  check('getBrandContacts computes res.cached for its own log line',
    /const source = res\.cached \? 'cache'/.test(gbc));
  // WAS THE BUG, IS NOW THE GUARD. This file was written to prove the field was
  // dropped; it stays to prove it is not dropped again. 152 lookups reported
  // 0.0% cached because this one field was missing from this one object.
  check('  and its return object CARRIES it (this is the bug, kept as a guard)',
    /cached: !!res\.cached/.test(retStmt), retStmt.replace(/\s+/g, ' ').slice(-90));

  // ── 3. WHAT THE NIGHTLY JOB THEREFORE RECORDS ─────────────────────────────
  console.log('\n3. THE CONSEQUENCE, RUN RATHER THAN READ');
  const SRC_JOB = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  // The job no longer prices off the boolean at all -- see cachefix.js. One
  // lookup makes several cache reads, so the meter is the source and the boolean
  // is only recorded as the contacts lane's own answer.
  const jobCode = SRC_JOB.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check('the job no longer prices from the boolean',
    !/let realCost = out\.cached \? 0 :/.test(jobCode));
  check('  it prices from the meter', /let realCost = Q\.priceOf\(meter\);/.test(jobCode));
  check('  and still records the contacts-lane flag', /cached: !!out\.cached/.test(SRC_JOB));

  // The shipping cost expression, evaluated against what getBrandContacts really
  // returns: an object with no `cached` key.
  const CEIL = require(ROOT + 'server/jobs/outreachQueue.js').LOOKUP_CEILING_USD;
  const price = (outObj, meter) => {
    let realCost = outObj.cached ? 0 : Q.priceOf(meter);
    if (!outObj.cached && realCost <= 0) realCost = CEIL;
    return { cost: realCost, cachedFlag: !!outObj.cached };
  };
  const asReturned = { contacts: [], businessPhone: '205-555-0100' };   // no `cached`
  // THE OLD ARITHMETIC, KEPT AS THE RECORD OF WHAT WENT WRONG. `price` here is
  // the expression the job USED to run. Under it, a lookup with no `cached` field
  // and an empty meter -- a perfect cache hit -- was charged the ceiling.
  const hitZeroMeter = price(asReturned, { webSearches: 0, aiCalls: 0 });
  check('under the OLD pricing a full cache hit was charged the ceiling',
    hitZeroMeter.cachedFlag === false && hitZeroMeter.cost === CEIL,
    '$' + hitZeroMeter.cost + ' (ceiling $' + CEIL + ')');
  // And under the shipping arithmetic it is free. Same meter, same lookup.
  const nowPrice = (meter) => {
    const touched = meter && (meter.cacheHits || meter.cacheMisses || meter.webSearches || meter.aiCalls);
    return touched ? Q.priceOf(meter) : CEIL;
  };
  check('  under the shipping pricing the same hit is free',
    nowPrice({ webSearches: 0, aiCalls: 0, cacheHits: 1, cacheMisses: 0 }) === 0);

  // A partial hit -- contacts cached, but the surrounding work still metered --
  // is the common case and prices normally. This is why the average paid lookup
  // is $0.0422 rather than pinned at the $0.06 ceiling.
  const partial = price(asReturned, { webSearches: 4, aiCalls: 1 });
  check('a partial hit is priced from the meter, so it hides in the average',
    partial.cost > 0 && partial.cost < CEIL, '$' + partial.cost);

  // ── 4. WHAT IS AND IS NOT COVERED BY THAT CACHE ───────────────────────────
  console.log('\n4. THE CONTACTS CACHE DOES NOT COVER THE WHOLE LOOKUP');
  check('deepContactCtx turns the address ladder on for the queue too',
    ai.deepContactCtx({ market: null, lean: true }).enrichEmail === true);
  check('  and sets stopAtTier1, which puts the queue on the "| manual" key',
    ai.deepContactCtx({ market: null, lean: true }).stopAtTier1 === true);
  check('the ladder, website resolve and Instagram lookup all sit OUTSIDE the contacts row',
    /_addr\.cost\.resolveSearches/.test(SRC_AI) && /_addr\.cost\.personSearches/.test(SRC_AI));

  console.log('\n5. THE METER ALREADY HOLDS THE ANSWER, UNRECORDED');
  const fields = Object.keys((await scanMeter.run(async () => null)).meter);
  check('scanMeter tracks cacheHits and cacheMisses',
    fields.includes('cacheHits') && fields.includes('cacheMisses'), JSON.stringify(fields));
  check('  AND spendLog now records them too, not just webSearches/aiCalls',
    /cacheHits: meter \? meter\.cacheHits : 0/.test(SRC_JOB)
    && /cacheMisses: meter \? meter\.cacheMisses : 0/.test(SRC_JOB));

  const failed = out.filter((x) => !x.ok);
  console.log('\n' + (out.length - failed.length) + '/' + out.length + ' passed');
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('THREW', e); process.exit(1); });
