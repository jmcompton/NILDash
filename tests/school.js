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
// School resolution and the removal of the hometown fallback.
const fs = require('fs');
const ROOT = REPO;
const R = require(ROOT + 'server/services/schoolResolver.js');
const AR = require(ROOT + 'server/services/athleteRecord.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// ── THE THREE NAMED FAILURES ────────────────────────────────────────────────
const named = [
  ['Virgina Tech', 'Blacksburg', 'misspelled'],
  ['UNIVERSITY OF PITTSBURGH', 'Pittsburgh', 'all caps'],
  ['Eastern Kentucky University', 'Richmond', 'carries the suffix'],
];
for (const [input, city, why] of named) {
  const r = R.resolveSchool(input);
  ok(`resolves "${input}" (${why})`, r && r.city === city, r);
}

// ── The classes of failure, generally ───────────────────────────────────────
const cases = [
  ['auburn', 'Auburn'], ['AUBURN UNIVERSITY', 'Auburn'], ['Univ. of Alabama', 'Tuscaloosa'],
  ['Eastern Kentucky', 'Richmond'], ['eku', 'Richmond'], ['LSU', 'Baton Rouge'],
  ['Ole Miss', 'Oxford'], ['texas a&m', 'College Station'], ['  Virginia Tech  ', 'Blacksburg'],
  ['University of Arkansas', 'Fayetteville'], ['arkansas', 'Fayetteville'],
];
for (const [input, city] of cases) {
  const r = R.resolveSchool(input);
  ok(`resolves "${input}"`, r && r.city === city, r && r.city);
}

// ── IT MUST NOT GUESS ───────────────────────────────────────────────────────
for (const bad of ['MSU', 'Nowhere Tech', 'Hogwarts', '', '   ', 'X', 'State']) {
  const r = R.resolveSchool(bad);
  ok(`refuses to guess on "${bad || '(empty)'}"`, r === null, r);
}
ok('an ambiguous alias is DELIBERATELY null, not a coin toss', R.ALIASES.msu === null);
ok('the fuzzy floor is high', R.MIN_CONFIDENCE >= 0.85, R.MIN_CONFIDENCE);
ok('  and a near tie is rejected by the margin rule', R.MIN_MARGIN > 0, R.MIN_MARGIN);
// One transposed letter resolves; a different school does not become the answer.
ok('one typo resolves', (R.resolveSchool('Auburm University') || {}).city === 'Auburn');
ok('  but an unrelated name does not', R.resolveSchool('Auckland University') === null,
  R.resolveSchool('Auckland University'));

// ── THE RECORD SURFACES AN UNMATCHED SCHOOL ─────────────────────────────────
const good = AR.resolveAthlete({ data: { name: 'A', school: 'Virgina Tech' } }, { schoolLocation: R.resolveSchool });
ok('a resolved school gives a market', good.hasLocalMarket && /Blacksburg/.test(good.market), good.market);
ok('  and records how it matched', good.marketSource === 'alias' || good.marketSource === 'fuzzy', good.marketSource);
ok('  naming what it matched to', good.schoolMatched === 'Virginia Tech', good.schoolMatched);
ok('  with no unmatched flag', good.schoolUnmatched === false && good.localLaneNote === null, good.localLaneNote);

const bad = AR.resolveAthlete({ data: { name: 'B', school: 'Nowhere Tech', hometown: 'Knoxville, TN' } },
  { schoolLocation: R.resolveSchool });
ok('an unmatched school gives NO market', bad.hasLocalMarket === false && bad.market === null, bad.market);
ok('  THE HOMETOWN IS NOT SUBSTITUTED', bad.market === null && bad.hometown === 'Knoxville, TN', bad);
ok('  it is flagged for the agent', bad.schoolUnmatched === true, bad);
ok('  with a note naming the school and the fix',
  /Nowhere Tech/.test(bad.localLaneNote) && /Correct the school/.test(bad.localLaneNote), bad.localLaneNote);

const none = AR.resolveAthlete({ data: { name: 'C', hometown: 'Harrisburg, PA' } }, { schoolLocation: R.resolveSchool });
ok('no school at all also gives no market', none.hasLocalMarket === false, none.market);
ok('  and says so', /No school on file/.test(none.localLaneNote), none.localLaneNote);

// ── THE FALLBACK IS GONE FROM THE JOB ───────────────────────────────────────
const JOB = fs.readFileSync(ROOT + 'server/jobs/outreachQueue.js', 'utf8');
const fn = JOB.slice(JOB.indexOf('function regionForAthlete'), JOB.indexOf('function regionForAthlete') + 400);
ok('regionForAthlete no longer reads hometown', !/hometown/.test(fn), fn);
ok('  it reads the resolved record', /AR\.resolveAthlete/.test(fn), fn);
ok('  and returns empty when there is no market', /rec\.market \|\| ''/.test(fn), fn);
// THE LOCAL LANE STOPS. THE ATHLETE DOES NOT. An earlier version returned from
// fillAthlete the moment the school failed to resolve, before the Scout ever
// ran -- which silenced social and national too, and those lanes have no
// geography to be wrong about. The invariant is now structural: the non-local
// guard sits BEFORE the first Places call, so a national brand can never be
// resolved to whatever storefront happens to be nearby.
const body = JOB.slice(JOB.indexOf('async function fillAthlete'), JOB.indexOf('async function fillAgent'));
ok('the no-market case is carried as a REASON, not an early blank',
  /const noMarket = !String\(region \|\| ''\)\.trim\(\)/.test(body), true);
ok('  and it no longer returns before the slate is assembled',
  body.indexOf('const noMarket =') < body.indexOf('Scout.assembleSlate'), true);
ok('a non-local candidate never reaches a Places lookup',
  body.indexOf("if (cand.lane && cand.lane !== 'local')") > 0
  && body.indexOf("if (cand.lane && cand.lane !== 'local')") < body.indexOf('await lookupPlace('), true);
ok('  nor the local contact ladder',
  body.indexOf("if (cand.lane && cand.lane !== 'local')") < body.indexOf('ai.getBrandContacts('), true);
ok('  before spending anything', JOB.indexOf('noMarket: true') < JOB.indexOf('lookupPlace('), 
  [JOB.indexOf('noMarket: true'), JOB.indexOf('lookupPlace(')]);
ok('  and the comment says geography binds the LOCAL lane only',
  /binds the LOCAL lane only|local lane only/i.test(JOB) || /Social, DTC and national/.test(JOB));

// The three real examples, end to end.
for (const [school, hometownCity] of [['Eastern Kentucky', 'Knoxville'], ['Virginia Tech', 'Harrisburg']]) {
  const rec = AR.resolveAthlete({ data: { name: 'X', school, hometown: hometownCity + ', TN' } },
    { schoolLocation: R.resolveSchool });
  ok(`${school}: market is the SCHOOL city, not ${hometownCity}`,
    rec.market && rec.market.indexOf(hometownCity) === -1, rec.market);
}

// ── ROUND TWO: what the first live pass surfaced ────────────────────────────
// The transposed-suffix bug. "Arizona State Univeristy" failed because the
// suffix strip matched the word EXACTLY, so the misspelling survived into the
// identity form and the single-edit allowance was comparing "arizona state
// univeristy" against "arizona state" -- a distance of 11, not 1.
ok('core() strips a MISSPELLED institution word',
  R.core('Arizona State Univeristy') === 'arizona state', R.core('Arizona State Univeristy'));
ok('  so the transposed suffix now resolves',
  (R.resolveSchool('Arizona State Univeristy') || {}).city === 'Tempe',
  R.resolveSchool('Arizona State Univeristy'));
ok('  and a correctly spelled one is unchanged',
  R.core('Arizona State University') === 'arizona state');
for (const v of ['Auburn Universty', 'Auburn Univercity', 'Auburn Collge']) {
  ok(`  "${v}" resolves too`, (R.resolveSchool(v) || {}).city === 'Auburn', R.resolveSchool(v));
}

// Parentheticals are notes, not names.
for (const v of ['Maryland (incoming; Class of 2026 recruit)',
  'University of Maryland (incoming, Class of 2026)', 'Maryland [transfer]']) {
  const r = R.resolveSchool(v);
  ok(`"${v}" resolves to College Park`, r && r.city === 'College Park', r);
}
ok('the parenthetical is split off the name',
  R.splitParenthetical('Maryland (incoming, 2026)').name === 'Maryland');
ok('  and a plain note leaves no state hint',
  R.splitParenthetical('Maryland (incoming, 2026)').stateHint === null);
ok('  but a STATE in parentheses is kept as a hint',
  R.splitParenthetical('Miami University (Ohio)').stateHint === 'OH');

// The schools that were simply missing.
const added = [['ULM', 'Monroe'], ['FAMU', 'Tallahassee'], ['The Citadel', 'Charleston'],
  ['Grambling State University', 'Grambling'], ['University of Montana', 'Missoula'],
  ['Cape Fear Community College', 'Wilmington'], ['Miami University (Ohio)', 'Oxford'],
  ["Saint Mary's College of California", 'Moraga'],
  ['University of Louisiana Monroe', 'Monroe'], ['Florida A&M University', 'Tallahassee'],
  ['Citadel', 'Charleston'], ['grambling', 'Grambling'], ['cape fear', 'Wilmington'],
  ['St Marys', 'Moraga'], ['famu', 'Tallahassee'], ['ulm', 'Monroe']];
for (const [name, city] of added) {
  const r = R.resolveSchool(name);
  ok(`added school "${name}"`, r && r.city === city, r);
}

// Miami is the ambiguity trap and must stay separated.
ok('"Miami University" is the OHIO one, per the real naming convention',
  (R.resolveSchool('Miami University') || {}).city === 'Oxford', R.resolveSchool('Miami University'));
ok('  while a bare "Miami" stays Coral Gables',
  (R.resolveSchool('Miami') || {}).city === 'Coral Gables', R.resolveSchool('Miami'));

// The guards survive all of it.
for (const bad of ['MSU', 'Nowhere Tech', 'State', 'Southern', '', '(incoming, 2026)']) {
  ok(`still refuses to guess on "${bad || '(empty)'}"`, R.resolveSchool(bad) === null, R.resolveSchool(bad));
}
ok('a parenthetical-only string resolves to nothing', R.resolveSchool('(transfer portal)') === null);

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
