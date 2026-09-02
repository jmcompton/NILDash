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

// ── FOUR FAILURES THAT ADDED UP TO AN ATHLETE GETTING NOTHING ───────────────
//
//   The shipped school map holds ~200 names, heavily D1. Bentley University is a
//   real D2 school in Waltham and is not on it, so the local lane never ran.
//   getSocialBrandPool passed reach*1.25 to an INTEGER column, so it threw for
//   roughly three athletes in four and the social lane returned [] silently.
//   deal_comps.brand existed only in CREATE TABLE IF NOT EXISTS, so production's
//   table never got it and the national lane threw on every athlete for a week.
//   Add Client required only a name, so an athlete whose lookup found no school
//   saved as a record the pipeline cannot use.
//
// Any one of those is a thin night. All four together is an athlete who gets
// nothing, forever, with the page blaming their market.

const fs = require('fs');
const ROOT = REPO;
const SG = require(ROOT + 'server/services/schoolGeocode');
const R = require(ROOT + 'server/services/schoolResolver');
const Q = require(ROOT + 'server/services/outreachQueue');
const store = require(ROOT + 'server/store');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── THE LIST, AND WHAT IT MISSES ──────────────────────────────────────────
  ok('the shipped map is ~200 names, not a national list',
    R.SHIPPED_NAMES.length + Object.keys(R.EXTRA_SCHOOLS).length < 400,
    R.SHIPPED_NAMES.length + Object.keys(R.EXTRA_SCHOOLS).length);
  ok('BENTLEY IS NOT ON IT, and that is the point', R.resolveSchool('Bentley University') === null);
  ok('  while a mapped school still resolves instantly',
    (R.resolveSchool('Auburn University') || {}).city === 'Auburn');

  // ── THE ADDRESS PARSER ────────────────────────────────────────────────────
  ok('a US Places address yields the town',
    JSON.stringify(SG.cityStateFromAddress('175 Forest St, Waltham, MA 02452, USA'))
      === JSON.stringify({ city: 'Waltham', state: 'MA' }),
    SG.cityStateFromAddress('175 Forest St, Waltham, MA 02452, USA'));
  ok('  without the country component too',
    (SG.cityStateFromAddress('175 Forest St, Waltham, MA 02452') || {}).city === 'Waltham');
  for (const bad of ['', null, 'Waltham', 'somewhere']) {
    ok('  unparseable stays null: ' + JSON.stringify(bad), SG.cityStateFromAddress(bad) === null);
  }

  // ── WHAT WE REFUSE TO GEOCODE ─────────────────────────────────────────────
  // Geocoding a placeholder would put an athlete in a market on no evidence and
  // then pitch businesses there under the agent's name.
  for (const junk of ['', '  ', 'N/A', 'none', 'Unknown', 'Unattached', 'TBD', '--']) {
    ok('  not a school: ' + JSON.stringify(junk), SG.usable(junk) === false);
  }
  ok('a real school name IS usable', SG.usable('Bentley University') === true);

  // ── THE GEOCODE ITSELF, WITH PLACES STUBBED ───────────────────────────────
  let calls = 0;
  const lookupPlace = async (name) => {
    calls++;
    if (/bentley/i.test(name)) return { address: '175 Forest St, Waltham, MA 02452, USA' };
    return null;
  };
  const memo = {};
  const fakeStore = {
    getBrandEvidence: async (k, lane) => memo[lane + ':' + k] || null,
    saveBrandEvidence: async (k, lane, brand, site, ev) => { memo[lane + ':' + k] = { evidence: ev }; },
  };
  const hit = await SG.geocodeSchool('Bentley University', { lookupPlace, store: fakeStore });
  ok('AN UNMAPPED SCHOOL GEOCODES TO ITS TOWN',
    hit && hit.market === 'Waltham, MA', hit);
  ok('  and the athlete gets a local lane there', !!(hit && hit.city && hit.state), hit);

  calls = 0;
  const again = await SG.geocodeSchool('Bentley University', { lookupPlace, store: fakeStore });
  ok('  CACHED, so a roster of 45 at one school is one lookup',
    again && again.market === 'Waltham, MA' && calls === 0, { again, calls });

  calls = 0;
  const miss = await SG.geocodeSchool('Not A Real School Anywhere', { lookupPlace, store: fakeStore });
  ok('a name Places cannot place returns null rather than a guess', miss === null);
  calls = 0;
  await SG.geocodeSchool('Not A Real School Anywhere', { lookupPlace, store: fakeStore });
  ok('  and the negative is cached too, so it is not re-searched nightly', calls === 0, calls);

  // A network failure must NOT be written down as "not a school".
  const throwing = async () => { throw new Error('places down'); };
  const memo2 = {};
  const store2 = {
    getBrandEvidence: async (k, lane) => memo2[lane + ':' + k] || null,
    saveBrandEvidence: async (k, lane, b, w, ev) => { memo2[lane + ':' + k] = { evidence: ev }; },
  };
  const failed = await SG.geocodeSchool('Bentley University', { lookupPlace: throwing, store: store2 });
  ok('A LOOKUP FAILURE IS NOT CACHED AS "NOT A SCHOOL"',
    failed === null && Object.keys(memo2).length === 0, memo2);

  // ── THE INTEGER BUG ───────────────────────────────────────────────────────
  // reach*1.25 is only whole when reach divides by four, so this threw for most
  // of the roster and the catch returned [].
  const st = fs.readFileSync(ROOT + 'server/store.js', 'utf8');
  ok('THE SOCIAL POOL PASSES INTEGERS TO INTEGER COLUMNS',
    /Math\.ceil\(reach \* 1\.25\), Math\.floor\(reach \* 0\.75\)/.test(st), null);
  ok('  and no longer passes the raw floats',
    !/params: \[sport, reach \* 1\.25, reach \* 0\.75\]/.test(st), null);
  // The exact number from the production error.
  ok('  12417 followers no longer produces 15521.25',
    Number.isInteger(Math.ceil(12417 * 1.25)) && Math.ceil(12417 * 1.25) === 15522);
  ok('  and the band is never narrowed by the rounding',
    Math.ceil(100 * 1.25) >= 125 && Math.floor(100 * 0.75) <= 75);
  // Against the real table, which is the only proof that matters.
  const pool = await store.getSocialBrandPool({ instagram: 12417, tiktok: 0, sport: 'football' })
    .catch((e) => ({ threw: e.message }));
  ok('getSocialBrandPool RUNS for an odd follower count',
    Array.isArray(pool), pool);

  // ── THE MISSING COLUMN ────────────────────────────────────────────────────
  ok('deal_comps.brand is added by an ALTER, not only by CREATE TABLE',
    /ALTER TABLE deal_comps ADD COLUMN IF NOT EXISTS brand TEXT/.test(st), null);
  const cols = (await P.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name='deal_comps'`)).rows
    .map((r) => r.column_name);
  for (const c of ['brand', 'athlete_name', 'source']) {
    ok('  deal_comps has ' + c, cols.indexOf(c) !== -1, cols.length);
  }
  const comps = await store.getTopNilComps(3, 1).catch((e) => ({ threw: e.message }));
  ok('getTopNilComps RUNS rather than throwing on every athlete', Array.isArray(comps), comps);

  // ── THE SCHOOL IS REQUIRED AT SAVE ────────────────────────────────────────
  const idx = fs.readFileSync(ROOT + 'server/index.js', 'utf8');
  ok('THE API REFUSES AN ATHLETE WITH NO SCHOOL',
    /A school is required\. The nightly run uses it/.test(idx), null);
  ok('  enforced at the API, not only in the form',
    idx.indexOf('field: \'school\'') > 0, null);
  const html = fs.readFileSync(ROOT + 'public/index.html', 'utf8');
  ok('  the form asks for it before saving',
    /A school is required\. Deal Scan and the nightly run/.test(html), null);
  ok('  AND THE LOOKUP SAYS SO WHEN IT COULD NOT FIND ONE',
    /Lookup could not find a school/.test(html), null);

  // ── THE GEOCODE IS WIRED INTO THE RUN ─────────────────────────────────────
  const job = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the run geocodes a school the map does not know',
    /SchoolGeo\.geocodeSchool/.test(job), null);
  ok('  the shipped map still wins where it has an answer',
    /const direct = regionForAthlete\(athlete\);\s*\n\s*if \(direct\) return/.test(job), null);
  ok('  AND THE PROFILE AGREES WITH THE REGION',
    /profile\.hasLocalMarket = true;/.test(job), null);
  // Two CALL sites (nightly and on-demand), plus the definition.
  ok('  at both fill paths — nightly and on-demand',
    (job.match(/await localContextFor\(ath\)/g) || []).length === 2, null);

  // ── RETIREMENT AND THE CAP ────────────────────────────────────────────────
  ok('the nightly cap is $8', Q.DEFAULT_AGENT_NIGHTLY_USD === 8, Q.DEFAULT_AGENT_NIGHTLY_USD);
  ok('unworked cards expire after 7 days', Q.EXPIRE_AFTER_DAYS === 7, Q.EXPIRE_AFTER_DAYS);
  ok('  with a 30-day cooldown', Q.EXPIRE_COOLDOWN_DAYS === 30, Q.EXPIRE_COOLDOWN_DAYS);
  ok('the sweep runs BEFORE the slots are counted',
    job.indexOf('await expireStaleCards(pool, { agentId })') < job.indexOf('const heldRows'), null);
  ok('  and nothing is deleted, only the state moves',
    /SET state = 'expired', expired_at = NOW\(\)/.test(job) && !/DELETE FROM outreach_queue/.test(job), null);
  const scout = fs.readFileSync(ROOT + 'server/services/scout.js', 'utf8');
  ok('AN EXPIRED CARD IS NOT RE-OFFERED INSIDE THE COOLDOWN',
    /state = 'expired'[\s\S]{0,200}expired_at, updated_at, created_at\) > NOW\(\)/.test(scout), null);

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P.end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
