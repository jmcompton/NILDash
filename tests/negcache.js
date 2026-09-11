'use strict';
// Runs from a checkout on any machine and needs NO database: the cache store is
// patched in-process so every write is observed rather than persisted.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/negcache.js       just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';

// ── AN ERROR IS NOT AN ANSWER ───────────────────────────────────────────────
//
// Peyton Bair's five cards were all CALL: phone number, no owner, no email, no
// handle -- a pizza place, a coffee house, a gym, all in Eugene. Running the
// ladder here with no keys showed the mechanism in one log line:
//
//   [instagram] search failed brand="Rock Creek Java" error=...
//   [cache] WRITE key=instagram:name:rockcreekjava@eugene | v2 -> ok (outcome=NONE)
//
// The search ERRORED and the code cached "no Instagram" for 30 days. A timeout,
// a rate limit, or a missing key at 3am on one night became, for every business
// tried that night, a month of no handle -- and channelFor's last resort is
// CALL. The domain resolver and the contacts fan-out both already refuse to
// cache an error; the Instagram lookup was the one that did not.
//
// WHAT THIS SUITE PROTECTS:
//   1. A search that THROWS writes nothing. The next lookup asks again.
//   2. A search that completes and finds nothing still writes NONE (that is a
//      real answer, and re-searching it nightly would be the opposite waste).
//   3. A found, cited handle writes OK, as before.
//   4. The domain resolver's existing correct behaviour is pinned, so it cannot
//      drift the way Instagram did.
//   5. The clearing script only ever deletes instagram NONE rows, dry-run first.

const fs = require('fs');
const store = require(REPO + 'server/store');
const IG = require(REPO + 'server/services/instagramLookup');
const DR = require(REPO + 'server/services/domainResolve');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};

// Observe the cache instead of using it.
const writes = [];
store.getBrandEvidence = async () => null;                       // always a miss
store.saveBrandEvidence = async (key, lane, brand, website, evidence, outcome) => { writes.push({ key, lane, brand, outcome, evidence }); };
const last = () => writes[writes.length - 1] || null;

async function main() {
  const brand = "Maxie's Pizza & Pasta", loc = 'Eugene, OR';

  // ── 1. THE SEARCH THROWS ──────────────────────────────────────────────────
  writes.length = 0;
  const throwing = async () => { throw new Error('ig-search-timeout'); };
  const r1 = await IG.findInstagram(null, { brand, loc, webSearch: throwing });
  ok('a search that throws returns no handle', r1 === null, r1);
  ok('  and WRITES NOTHING to the cache', writes.length === 0, writes);

  const apiDown = async () => { throw new Error('ANTHROPIC_API_KEY not set'); };
  writes.length = 0;
  await IG.findInstagram(null, { brand, loc, webSearch: apiDown });
  ok('  a missing key is an error too, not a finding', writes.length === 0, writes);

  // ── 2. THE SEARCH COMPLETES AND FINDS NOTHING ─────────────────────────────
  writes.length = 0;
  const empty = async () => ({ text: '{"handle":null,"ownerName":null,"bookingEmail":null,"bioText":null}', citations: [] });
  const r2 = await IG.findInstagram(null, { brand, loc, webSearch: empty });
  ok('a completed search that finds nothing returns no handle', r2 === null, r2);
  ok('  and DOES write NONE -- that is a real answer', last() && last().lane === 'instagram' && last().outcome === 'NONE', last());
  ok('  keyed by name and city, since there was no domain', /^name:maxiespizzapasta@eugene/.test(last().key), last().key);

  // ── 3. A FOUND, CITED HANDLE ──────────────────────────────────────────────
  writes.length = 0;
  const hit = async () => ({
    text: '{"handle":"maxiespizza","ownerName":null,"bookingEmail":null,"bioText":null}',
    citations: ['https://www.instagram.com/maxiespizza/'],
  });
  const r3 = await IG.findInstagram(null, { brand, loc, webSearch: hit });
  ok('a cited handle that names the business is returned', r3 && r3.handle === 'maxiespizza' && r3.source === 'search', r3);
  ok('  and writes OK', last() && last().outcome === 'OK' && last().evidence.found === true, last());

  // An uncited handle is still refused (the model may have constructed it), and
  // THAT refusal is a completed search -- so it caches NONE, as before.
  writes.length = 0;
  const uncited = async () => ({ text: '{"handle":"maxiespizza"}', citations: [] });
  const r4 = await IG.findInstagram(null, { brand, loc, webSearch: uncited });
  ok('an uncited handle is refused', r4 === null, r4);
  ok('  and that IS cached as NONE (the search completed)', last() && last().outcome === 'NONE', last());

  // ── 4. THE DOMAIN RESOLVER ALREADY DOES THIS, AND MUST KEEP DOING IT ──────
  writes.length = 0;
  const d1 = await DR.resolveDomain(brand, { city: loc, address: null, webSearch: throwing });
  ok('domain-resolve: a throwing search returns no website', d1 && d1.website === null && /search failed/.test(d1.reason || ''), d1);
  ok('  and writes nothing', writes.length === 0, writes);
  writes.length = 0;
  const d2 = await DR.resolveDomain(brand, { city: loc, address: null, webSearch: empty });
  ok('domain-resolve: an empty completed search still caches NONE', d2 && d2.website === null && last() && last().outcome === 'NONE', { d2, last: last() });

  // ── 5. THE SOURCE AND THE SCRIPT ──────────────────────────────────────────
  {
    const src = fs.readFileSync(REPO + 'server/services/instagramLookup.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    ok('the search helper returns a distinct value on error, not null',
      /return \{ error: \(e && e\.message\) \|\| 'search failed' \};/.test(src), null);
    ok('  and the NONE write is gated on it',
      /if \(searchFailed\) \{[\s\S]{0,300}return null;\s*\}[\s\S]{0,400}saveBrandEvidence\(key, 'instagram'/.test(src), null);
    const sc = fs.readFileSync(REPO + 'scripts/clear-negative-cache.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
    ok('the clearing script deletes only instagram NONE rows',
      /lane = 'instagram'/.test(sc) && /outcome = 'NONE'/.test(sc) && !/outcome = 'OK'/.test(sc), null);
    ok('  is a dry run unless --apply', /const APPLY = process\.argv\.includes\('--apply'\)/.test(sc) && /Dry run:/.test(sc), null);
    ok('  connects through server/store and never builds a bare pool', /require\('\.\.\/server\/store'\)/.test(sc) && !/new Pool\(/.test(sc), null);
    ok('  and starts with exit code 1 until it has reported', /process\.exitCode = 1/.test(sc), null);
  }

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
