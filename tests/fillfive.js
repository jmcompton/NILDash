'use strict';
// Runs from a checkout on any machine and needs NO database.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/fillfive.js       just this one

// ── FIVE EVERY MORNING, OR A REASON ─────────────────────────────────────────
//
// The fill used to draw open slots x 3 candidates and stop; if none passed the
// bar the athlete got nothing. It now keeps drawing until every open slot is
// filled -- re-draw, refill the market, widen -- and stops for exactly one of:
// the money, the ceilings, or the ladder exhausted (the rate floor is gone). And when it stops short, the
// note is a sentence with counts, not "none passed the bar".
//
// WHAT THIS SUITE PROTECTS:
//
//   1. THE RATE FLOOR IS EXACT. 1 in 8 means one pass in the last eight real
//      attempts is NOT under the floor; zero is. Off by one here either grinds a
//      dead market for the whole share or gives up on a live one after eight.
//
//   2. THE FLOOR MEASURES THE POOL, NOT THE PLUMBING. A program-cap skip, a
//      routing reject and a lookup that threw say nothing about whether
//      businesses in this town can be reached; they must not count.
//
//   3. DISCOVERY IS A SEPARATE POT. A widen never touches the athlete's share
//      or the lookup cap, and stops at its own ceiling.
//
//   4. THE HONEST STOP HAS THE COUNTS IN IT.
//
//   5. THE JOB IS WIRED THE WAY THE PIECES ASSUME: no attempt ceiling, refill on
//      drain and on rate, both scans metered and booked to discovery.

const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const fs = require('fs');
const Q = require(REPO + 'server/services/outreachQueue');

let OUT = [], F = 0;
const ok = (n, c, g) => {
  if (c) OUT.push('PASS ' + n);
  else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); }
};
const rej = (n) => Array.from({ length: n }, (_, i) => ({ brand: 'R' + i, result: 'rejected', reason: 'nothing reachable — found only a name' }));
const q = (n) => Array.from({ length: n }, (_, i) => ({ brand: 'Q' + i, result: 'queued', reason: null }));

// ── 1. THERE IS NO RATE STOP ────────────────────────────────────────────
// passRateStop is deleted: the fill exits on five, the cost ceiling, the time
// ceiling or an exhausted ladder, and nothing else (tests/floorloop.js).
{
  ok('passRateStop and the rate floor are gone', Q.passRateStop === undefined && Q.RATE_FLOOR === undefined && Q.RATE_WINDOW === undefined);
}

// ── 3. DISCOVERY IS ITS OWN POT ───────────────────────────────────────────
{
  const b = Q.newBudget(8, 2);
  b.openFor(9);
  const share = b.shareOf();
  ok('the discovery ceiling is $2 by default', Q.DISCOVERY_CAP_USD === 2 && b.discoveryCap() === 2, [Q.DISCOVERY_CAP_USD, b.discoveryCap()]);
  b.spendDiscovery(0.25);
  ok('a widen does not touch the athlete\'s share', b.shareLeft() === share, { share, left: b.shareLeft() });
  ok('  nor the lookup cap', b.spent() === 0 && b.remaining() === 8, { spent: b.spent(), remaining: b.remaining() });
  ok('  and is counted where it belongs', b.discoverySpent() === 0.25, b.discoverySpent());
  b.spendDiscovery(1.6);
  // ── THE POT AND THE SHARE ARE TWO DIFFERENT CEILINGS ────────────────────
  // canSpendDiscovery answers BOTH of them since 8ae619e gave the discovery
  // pot the per-athlete share the lookup cap always had -- the fix for two
  // athletes' cold-market scans draining a $2 night, and 28 of 30 being told
  // "the discovery pot is spent" before they were attempted at all.
  //
  // So `  but still affords what fits` started asking the wrong accessor that
  // day and has been red since: $1.85 is inside the $2 pot but far outside
  // this athlete's $2/9 share, and it is the SHARE that refuses. The claim it
  // was written to protect -- the pot is a ceiling, not an all-or-nothing
  // gate -- is still true and still worth pinning, so it is pinned on the
  // pot-only accessor that now carries it. Each ceiling is named by the
  // accessor that owns it, rather than one assertion that passes on whichever
  // of the two happens to say no first.
  ok('the pot refuses what it cannot afford', b.canSpendDiscoveryFromPot(0.25) === false, b.discoverySpent());
  ok('  but still affords what fits', b.canSpendDiscoveryFromPot(0.15) === true, b.discoverySpent());
  ok('  AND THE SHARE STOPS ONE ATHLETE SPENDING THE NIGHT, even where the pot would allow it',
    b.canSpendDiscovery(0.15) === false, { used: b.discoverySpent(), shareLeft: b.discoveryShareLeft() });
  const d = Q.newBudget(8);
  ok('the default pot is the constant', d.discoveryCap() === Q.DISCOVERY_CAP_USD, d.discoveryCap());
  ok('a lookup still spends from the share, as before', (d.openFor(1), d.spend(0.06), d.shareLeft() < d.shareOf()), null);
}

// ── 3b. PLACES IS PRICED ──────────────────────────────────────────────────
{
  const m = { webSearches: 4, aiCalls: 1, placesCalls: 25 };
  const expect = Math.round((4 * Q.USD_PER_WEB_SEARCH + 1 * Q.USD_PER_AI_CALL + 25 * Q.USD_PER_PLACES_REQUEST) * 10000) / 10000;
  ok('priceOf includes Places requests', Q.priceOf(m) === expect && Q.priceOf(m) > 0.8, Q.priceOf(m));
  ok('  a meter without the field prices as before', Q.priceOf({ webSearches: 4, aiCalls: 1 }) === 0.043, Q.priceOf({ webSearches: 4, aiCalls: 1 }));
  const sm = require(REPO + 'server/scanMeter');
  ok('the meter has a Places counter and a bump', typeof sm.bumpPlaces === 'function', null);
  const pm = fs.readFileSync(REPO + 'server/services/placesMarket.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok('  and every Places request bumps it', /scanMeter\.bumpPlaces\(\);\s*\n\s*const resp = await fetch/.test(pm), null);
}

// ── 4. THE HONEST STOP ────────────────────────────────────────────────────
{
  const n = Q.workedOutNote({ athleteName: 'Jeremiah Wilkinson', market: 'Fayetteville, AR',
    triedWeek: 41, reachableWeek: 6, widenedWeek: 2, filled: 0, wanted: 5 });
  ok('names the market and the athlete', /^Fayetteville, AR is worked out for Jeremiah Wilkinson:/.test(n), n);
  ok('  carries the week\'s counts', /41 businesses tried this week, 6 reachable, all pitched, widened 2 times\./.test(n), n);
  ok('  says what tonight produced', /Nothing new tonight\./.test(n), n);
  ok('  and what to do next', /Next: add a hometown, or a brand they already know/.test(n), n);
  const partial = Q.workedOutNote({ athleteName: 'Kaden House', market: 'College Park, MD', triedWeek: 12, reachableWeek: 3, widenedWeek: 1, filled: 3, wanted: 5 });
  ok('a partial night says how many of five', /3 of 5 slots filled tonight\./.test(partial) && /widened 1 time\./.test(partial), partial);
  const none = Q.workedOutNote({ athleteName: 'X', market: 'Y', triedWeek: 1, reachableWeek: 0, widenedWeek: 0, filled: 0, wanted: 5 });
  ok('zero reachable is said plainly, singular agrees', /1 business tried this week, none reachable\./.test(none) && !/widened/.test(none), none);
  ok('no market string still reads as a sentence', /^X's local market is worked out:/.test(Q.workedOutNote({ athleteName: 'X' })), Q.workedOutNote({ athleteName: 'X' }));
}

// ── 5. THE JOB IS WIRED THIS WAY ──────────────────────────────────────────
{
  const job = fs.readFileSync(REPO + 'server/jobs/outreachQueue.js', 'utf8').replace(/^\s*\/\/.*$/gm, '');
  ok('the attempt loop is no longer bounded by MAX_ATTEMPTS_PER_SLOT',
    /for \(let attempt = 0; !placed && !stop; attempt\+\+\)/.test(job)
    && !/for \(let attempt = 0; attempt < Q\.MAX_ATTEMPTS_PER_SLOT/.test(job), null);
  ok('  it refills when the slate drains', /if \(ci >= cands\.length\) \{\s*const added = await refillSlate\('slate drained'\)/.test(job), null);
  // The outcome loop (tests/floorloop.js): no rate stop, no rate trigger.
  ok('  and nothing reads a pass rate any more', !/passRateStop/.test(job) && !/stop = 'rate'/.test(job), null);
  ok('  the money check is still the first thing before a lookup', /const cand = cands\[ci\+\+\];[\s\S]{0,400}if \(!budget\.canSpend\(LOOKUP_CEILING_USD\)\)/.test(job), null);
  // The discovery call is metered AND labelled 'discovery' for the call ledger.
  ok('both scans run under the meter', (job.match(/scanMeter\.run\(\(\) =>\s*scanMeter\.label\(\{ site: 'discovery'[^\n]*\n\s*\(\) => ai\.getDealRecommendations/g) || []).length === 1
    && /async function discover\(/.test(job), null);
  ok('  and are booked to discovery, never the share', /budget\.spendDiscovery\(cost\)/.test(job) && !/budget\.spend\(cost\)/.test(job.slice(job.indexOf('async function discover('), job.indexOf('async function refillSlate('))), null);
  ok('  the pot is checked before spending', /budget\.canSpendDiscovery\(estimateUsd\)/.test(job), null);
  ok('the market refill runs once per market per run', /refilledMarkets\.has\(profile\.marketKey\)/.test(job) && /refilledMarkets\.add\(profile\.marketKey\)/.test(job), null);
  ok('  and the run shares that set across athletes', /refilledMarkets: _refilledMarkets/.test(job) && /const _refilledMarkets = new Set\(\)/.test(job), null);
  // widenKey is the school, or the market for a pro (who has no school).
  ok('the widen is still gated per athlete per market', /const widenKey = profile\.school \|\| profile\.market;/.test(job)
    && /Deepen\.canDeepen\(pool, widenKey, \{ athleteId \}\)/.test(job) && /widenedTonight = true/.test(job), null);
  ok('the stop note is built from workedOutNote with the week\'s counts', /Q\.workedOutNote\(\{ athleteName, market: profile\.market/.test(job) && /triedWeek, reachableWeek, widenedWeek, filled, wanted: open\.length/.test(job), null);
  ok('  and is what the run row carries as the note', /const note = filled > 0 && !stopNote \? null\s*:\s*stopNote/.test(job), null);
  ok('the three-nights backoff is untouched', /BACKOFF_NIGHTS = 3/.test(fs.readFileSync(REPO + 'server/services/outreachQueue.js', 'utf8')) && /failures >= Q\.BACKOFF_NIGHTS/.test(job), null);
}

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
