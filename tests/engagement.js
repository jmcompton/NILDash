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
// The engagement default, removed. nilViewVal is REQUIRED and executed, not read.
const fs = require('fs');
const b = require(REPO + 'server/benchmarks.js');
let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };
const BM = fs.readFileSync(REPO + 'server/benchmarks.js', 'utf8');
const IDX = fs.readFileSync(REPO + 'public/index.html', 'utf8');

const base = { instagram: 12000, tiktok: 3000, sport: 'basketball', schoolTier: 'mid-mid', position: 'G', school: 'Stanford' };
const withEr = (er) => { const a = { ...base }; if (er !== undefined) a.engagement = er; return a; };
const run = (er, t) => b.nilViewVal(withEr(er), t || 'ig-reel');

console.log('-- 1. NOTHING IS GUESSED --');
ok('the 3.0 default is gone from the source', !/parseFloat\(athlete\.engagement\) \|\| 3\.0/.test(BM));
// Scoped to nilViewVal: generateRateLimitations uses `|| 0` deliberately, to mean
// "no rate on file", and that is what makes the disclosure line fire.
const NVV = BM.slice(BM.indexOf('function nilViewVal('), BM.indexOf('function calcCompositeScores('));
ok('and no numeric default replaced it inside nilViewVal',
  !/parseFloat\(athlete\.engagement\) \|\| [0-9]/.test(NVV),
  (NVV.match(/parseFloat\(athlete\.engagement\)[^;]*/) || [])[0]);
ok('  it resolves to null instead', /const er  = erKnown \? erRaw : null;/.test(NVV));
ok('4.8 was NOT adopted as a stand-in', !/engagement\) \|\| 4\.8/.test(BM));

const absent = run(undefined);
ok('with engagement absent the multiplier is exactly 1.00 (identity)',
  absent.breakdown.engMult === '1.00', absent.breakdown.engMult);
ok('  which is not the same as assuming 4.8',
  absent.breakdown.engMult !== run(4.8).breakdown.engMult);
ok('  nor the same as the old 3.0 assumption',
  absent.breakdown.engMult !== run(3.0).breakdown.engMult, [absent.breakdown.engMult, run(3.0).breakdown.engMult]);
for (const bad of [undefined, null, 0, '', 'abc', -2, NaN]) {
  ok('  a non-value (' + JSON.stringify(bad) + ') applies no multiplier',
    run(bad).breakdown.engMult === '1.00', run(bad).breakdown.engMult);
}

console.log('\n-- 2. THE RANGE WIDENS TO SAY SO --');
const known = run(4.8);
const spread = (r) => (r.high - r.low) / r.mid;
ok('the unknown case is wider', spread(absent) > spread(known),
  [spread(absent).toFixed(2), spread(known).toFixed(2)]);
ok('  materially wider, not a token amount', spread(absent) - spread(known) > 0.3,
  (spread(absent) - spread(known)).toFixed(2));
// CORRECTED PREMISE. Comparing ends against the KNOWN case was wrong: an athlete
// with a measured 4.8% rate earns a 1.20 multiplier that the unknown case does not
// get, so its centre is legitimately higher. The property that matters is that the
// unknown range is symmetric about its OWN midpoint -- widened, not shifted.
ok('the widening is symmetric about its own midpoint',
  Math.abs((absent.high - absent.mid) - (absent.mid - absent.low)) <= 1,
  [absent.low, absent.mid, absent.high]);
ok('  and the known case is symmetric about its midpoint too',
  Math.abs((known.high - known.mid) - (known.mid - known.low)) <= 1,
  [known.low, known.mid, known.high]);
ok('the midpoint is not dragged down the way the 3.0 assumption dragged it',
  absent.mid > run(3.0).mid, [absent.mid, run(3.0).mid]);
ok('and the widening is bounded, not unbounded', spread(absent) < 2.0, spread(absent).toFixed(2));

console.log('\n-- 3. THE CONFIDENCE SCORE IS WITHHELD, NOT LOWERED --');
ok('it is null when engagement is unknown', absent.confidenceScore === null, absent.confidenceScore);
ok('not 0, which would be its own false claim', absent.confidenceScore !== 0);
ok('not a reduced number either', typeof absent.confidenceScore !== 'number');
ok('accuracyScore is withheld with it', absent.accuracyScore === null, absent.accuracyScore);
ok('an explicit engagementKnown flag is returned', absent.engagementKnown === false, absent.engagementKnown);
ok('and it is true when a rate IS on file', known.engagementKnown === true);
ok('the score comes back when engagement is known', typeof known.confidenceScore === 'number', known.confidenceScore);
ok('  the data tally no longer credits an absent input',
  /\(erKnown \? 20 : 0\)/.test(BM));

console.log('\n-- 4. IT IS DISCLOSED IN WORDS --');
const lims = (er) => b.generateRateLimitations(withEr(er), run(er), 0) || [];
const absentLims = lims(undefined);
ok('a limitation names the missing engagement rate',
  absentLims.some((l) => /Engagement rate not on file/.test(l)), absentLims);
ok('  and says no adjustment was applied',
  absentLims.some((l) => /no engagement adjustment applied/.test(l)));
ok('  and that the range was widened because of it',
  absentLims.some((l) => /range is widened/.test(l)));
ok('the line does NOT appear when a rate is on file',
  !lims(4.8).some((l) => /not on file/.test(l)), lims(4.8));
ok('a low-but-real rate still gets the below-average note, not the missing one',
  lims(1.5).some((l) => /below platform average/.test(l))
  && !lims(1.5).some((l) => /not on file/.test(l)), lims(1.5));

console.log('\n-- 5. AN ATHLETE WITH A REAL RATE IS COMPLETELY UNAFFECTED --');
for (const er of [1.5, 3.0, 4.8, 6.0, 9.0, 20.0]) {
  const r = run(er);
  ok('  er=' + er + ' keeps the standard 60% spread',
    Math.abs(spread(r) - 0.60) < 0.01, spread(r).toFixed(3));
  ok('  er=' + er + ' still reports a numeric confidence', typeof r.confidenceScore === 'number');
}
// The exact figures from before the change, for the cases that had a real rate.
ok('er=4.8 still returns $130 / $185 / $241',
  known.low === 130 && known.mid === 185 && known.high === 241, [known.low, known.mid, known.high]);
ok('er=9.0 still returns $162 / $231 / $301',
  run(9).low === 162 && run(9).mid === 231 && run(9).high === 301, [run(9).low, run(9).mid, run(9).high]);

console.log('\n-- 6. THE FLAT-FEE PATH GOT THE SAME TREATMENT --');
const flatAbsent = run(undefined, 'appearance-inperson');
const flatKnown = run(4.8, 'appearance-inperson');
ok('an appearance with no engagement applies no multiplier',
  flatAbsent.breakdown.engMult === '1.00', flatAbsent.breakdown.engMult);
ok('and withholds its confidence score', flatAbsent.confidenceScore === null, flatAbsent.confidenceScore);
ok('while a known rate still scores', typeof flatKnown.confidenceScore === 'number', flatKnown.confidenceScore);
ok('the flag is returned on this path too', flatAbsent.engagementKnown === false);

console.log('\n-- 7. MISSING DATA IS NOT SILENTLY PENALISED EITHER --');
ok('the composite marketability does not fall to the lowest band',
  absent.marketabilityScore > run(0.5).marketabilityScore,
  [absent.marketabilityScore, run(0.5).marketabilityScore]);
ok('  it sits at the mid band, matching neither best nor worst',
  absent.marketabilityScore < run(15).marketabilityScore
  && absent.marketabilityScore > run(1).marketabilityScore,
  [run(1).marketabilityScore, absent.marketabilityScore, run(15).marketabilityScore]);
ok('the null branch is explicit in the source', /if \(er === null \|\| er === undefined\) mkt \+= 5;/.test(BM));

console.log('\n-- 8. THE UI SHOWS WITHHELD AS WITHHELD --');
ok('the score card no longer coerces null to 0', !/\['Data Confidence', sc\.confidenceScore \|\| 0\]/.test(IDX));
ok('it passes null through', /sc\.confidenceScore == null \? null : sc\.confidenceScore/.test(IDX));
ok('a withheld score renders a dash, not a number', /raw == null\)/.test(IDX) && /&mdash;<\/div>/.test(IDX));
ok('with the reason next to it', /Not scored &mdash; engagement rate not on file/.test(IDX));
// RUN THE RENDERER. This used to assert !/raw == null\)[\s\S]{0,300}bar\(/ --
// which passed only because the nearest bar( sits 629 characters away, in the
// ELSE branch where it belongs. A bar added to the withheld branch 320 characters
// in would have passed too. It measured distance, not behaviour, and reported
// confidence it had not earned. Same failure as the hometown assertion that
// passed on a word surviving in a comment.
const cardSrc = IDX.slice(IDX.indexOf('function bar(n)'),
  IDX.indexOf("html += '</div>';", IDX.indexOf('scoreCards.forEach')));
const renderCards = new Function('data', 'scoreColor',
  cardSrc + " html += '</div>'; return html;");
const withheld = renderCards({ scores: { marketabilityScore: 71, sponsorshipReadiness: 64,
  audienceQuality: 58, confidenceScore: null } }, () => '#84CC16');
const scored = renderCards({ scores: { marketabilityScore: 71, sponsorshipReadiness: 64,
  audienceQuality: 58, confidenceScore: 88 } }, () => '#84CC16');

// The withheld card, isolated from the three that ARE scored.
const cardOf = (html, label) => {
  const i = html.indexOf(label);
  return i < 0 ? '' : html.slice(html.lastIndexOf('<div style="background:var(--surface2)', i), i + 420);
};
const wCard = cardOf(withheld, 'Data Confidence');
const sCard = cardOf(scored, 'Data Confidence');

ok('a withheld score renders a dash', /&mdash;<\/div>/.test(wCard), wCard.slice(0, 200));
ok('  with the reason beside it', /Not scored &mdash; engagement rate not on file/.test(wCard));
ok('  and NO bar, because a bar of any length is a score',
  wCard.indexOf('transition:width') === -1, wCard);
ok('  and no 0/100 either', !/>0<span/.test(wCard) && wCard.indexOf('/100') === -1, wCard);
// The control: a score that IS present still draws its bar, so the assertion
// above is about the withheld branch and not about bars being gone everywhere.
ok('a present score still draws its bar', sCard.indexOf('transition:width') !== -1, sCard.slice(0, 200));
ok('  and still shows the number', /88<span/.test(sCard), sCard.slice(0, 260));

console.log('\n-- 9. THE HOME HERO SAYS WHAT IT MEASURES --');
ok('the hero no longer claims to be a NIL valuation', !/'Your NIL value'/.test(IDX));
ok('it says Tracked deal value', /eyebrow\.textContent = 'Tracked deal value'/.test(IDX));
ok('which is what the endpoint actually sums',
  /SELECT COALESCE\(SUM\(value\), 0\) AS total FROM athlete_self_deals/
    .test(fs.readFileSync(REPO + 'server/index.js', 'utf8')));
ok('and the empty state matches the new label', /No deals tracked yet/.test(IDX));

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
