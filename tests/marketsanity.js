'use strict';
// Runs against the local test Postgres. No network: Places is a stub.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/marketsanity.js   just this one
//
// ── THE RIGHT TOWN, AND THE RIGHT PERSON'S ADDRESS ────────────────────────
// Two bugs from the first cold-agent run, both underneath every nightly card:
//   "Columbia University" (New York) resolved to Columbia, Missouri, and the
//   demo was five mid-Missouri businesses with 573 numbers.
//   A Domino's card named Greg Neichter, owner, with austin.mitchell@dominos.com:
//   a name from one source and someone else's mailbox from another.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const SMC = require(REPO + 'server/services/schoolMarketCheck.js');
const R = require(REPO + 'server/services/schoolResolver.js');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };

// Where things really are.
const PLACES = {
  'columbia university': { lat: 40.8075, lng: -73.9626, address: '116th St & Broadway, New York, NY 10027, USA' },
  'columbia, mo': { lat: 38.9517, lng: -92.3341, address: 'Columbia, MO, USA' },
  'university of dayton': { lat: 39.7400, lng: -84.1793, address: '300 College Park, Dayton, OH 45469, USA' },
  'dayton, oh': { lat: 39.7589, lng: -84.1916, address: 'Dayton, OH, USA' },
};
const calls = [];
const geocodePlace = async (q) => { calls.push(q); return PLACES[String(q).toLowerCase()] || null; };

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await SMC.ensureTable(P);
  await P.query(`DELETE FROM school_market_overrides WHERE school_key IN ('columbia university', 'university of dayton')`);
  SMC._resetForTests();

  // ── 1. THE NAME RULES NO LONGER CONFUSE THE KIND OF SCHOOL ───────────────
  OUT.push('-- the name rules --');
  ok('"Columbia University" no longer resolves to Columbia, Missouri', (R.resolveSchool('Columbia University') || {}).state !== 'MO', R.resolveSchool('Columbia University'));
  ok('"College of Charleston" no longer resolves to West Virginia', (R.resolveSchool('College of Charleston') || {}).state !== 'WV', R.resolveSchool('College of Charleston'));

  // ── 2. EVERY MARKET CHECKED AGAINST WHERE THE SCHOOL IS ─────────────────
  OUT.push('', '-- located, not named --');
  const v = await SMC.verify('Columbia University', 'Columbia, MO', { geocodePlace });
  ok('a market 1,500 km from the school is caught', v.checked && !v.ok && v.km > 1400, v);
  ok('  and the school\'s own address gives the right town', v.market === 'New York, NY', v);
  const good = await SMC.verify('University of Dayton', 'Dayton, OH', { geocodePlace });
  ok('a market within 60 km of the school is left alone', good.checked && good.ok && good.km < 60, good);
  calls.length = 0;
  const bare = await SMC.verify('Columbia', 'Columbia, MO', { geocodePlace });
  ok('a bare ambiguous name is not "corrected" to whichever Columbia ranks first', !bare.checked && calls.length === 0, bare);
  const lost = await SMC.verify('Columbia University', 'Nowhere, ZZ', { geocodePlace });
  ok('a market that cannot be located is reported, not guessed', !lost.checked && /could not locate/.test(lost.why), lost);

  // Corrected once, it is the answer on every path.
  const c = await SMC.checkAndCorrect(P, 'Columbia University', 'Columbia, MO', { geocodePlace });
  ok('a wrong market is corrected and saved', c.corrected && (await P.query(`SELECT market, was_market FROM school_market_overrides WHERE school_key = 'columbia university'`)).rows[0].market === 'New York, NY');
  const r = R.resolveSchool('Columbia University');
  ok('  the resolver answers with where the school is, for every caller', r && r.city === 'New York' && r.state === 'NY' && r.method === 'located', r);
  const job = require(REPO + 'server/jobs/outreachQueue.js');
  const prof = job.athleteProfile({ id: 'x', name: 'T', data: { name: 'T', school: 'Columbia University' } });
  ok('  the athlete\'s profile and market follow it', /new york/i.test(prof.market || '') && prof.hasLocalMarket, prof.market);
  SMC._resetForTests();
  ok('  and it survives a restart (loaded from the table)', (await SMC.load(P)) >= 1 && (R.resolveSchool('Columbia University') || {}).state === 'NY');
  const src = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8');
  ok('the nightly checks every name-rule market before using it, and loads the corrections first',
    /schoolMarketCheck'\)\.checkAndCorrect\(store\.pool, _school, profile\.market\)/.test(src) && /schoolMarketCheck'\)\.load\(pool\)/.test(src));
  await P.query(`DELETE FROM school_market_overrides WHERE school_key IN ('columbia university', 'university of dayton')`);
  SMC._resetForTests();

  // ── 3. THE ADDRESS HAS TO BE THE PERSON'S ───────────────────────────────
  OUT.push('', '-- the right person\'s address --');
  const ladder = (rows) => ({ tiers: [{ tier: 1, rows: [{ name: 'Greg Neichter', title: 'Owner', sourceNote: 'state filing' }] }, { tier: 3, rows }] });
  const stitched = Q.buildCard({ brand: "Domino's" }, ladder([{ email: 'austin.mitchell@dominos.com', emailKind: 'published', title: 'named mailbox' }]), { instagram: 'dominos5512', instagramScope: 'location' });
  ok('Greg Neichter is never given austin.mitchell@: the card carries no email', stitched.contactName === 'Greg Neichter' && stitched.email === null, stitched);
  ok('  and goes out as a DM (or a call), not an email to Austin opening "Hi Greg"', stitched.channel !== 'email' && Q.channelFor(ladder([{ email: 'austin.mitchell@dominos.com', emailKind: 'published' }]), null) === 'call');
  const his = Q.buildCard({ brand: "Domino's" }, ladder([{ email: 'gneichter@dominos.com', emailKind: 'pattern' }]), null);
  ok('his own address (it carries his name) is his', his.email === 'gneichter@dominos.com' && his.channel === 'email', his);
  const same = Q.buildCard({ brand: "Domino's" }, { tiers: [{ tier: 1, rows: [{ name: 'Greg Neichter', title: 'Owner', email: 'franchise5512@dominos.com', emailKind: 'published' }] }] }, null);
  ok('an address published ON his own row is his, whatever it says', same.email === 'franchise5512@dominos.com', same);
  const other = Q.buildCard({ brand: "Domino's" }, { tiers: [{ tier: 1, rows: [{ name: 'Greg Neichter', title: 'Owner' }, { name: 'Austin Mitchell', title: 'Manager', email: 'austin.mitchell@dominos.com', emailKind: 'published' }] }] }, null);
  ok('another named person\'s address is not borrowed for the owner', other.contactName !== 'Greg Neichter' || other.email !== 'austin.mitchell@dominos.com', other);

  OUT.push('', 'failures: ' + F);
  console.log(OUT.join('\n'));
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { OUT.push('FAIL threw: ' + (e && e.stack)); console.log(OUT.join('\n')); process.exit(1); });
