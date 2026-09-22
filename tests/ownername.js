'use strict';
// Runs from a checkout on any machine: no database, no network, no key.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/ownername.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const fs = require('fs');

// ── THE OWNER FIELD ON WILVET SOUTH HELD A SENTENCE ─────────────────────────
//
//   "The practice is led by Dr. Sarah Wilson, Dr. James Vetter, Dr. Amy Chen,
//    Dr. Mark Ross and Dr. Lisa Kim"
//
// 103 characters, five people, a verb. It passed personNameProblem because
// that function asked "is this a role", "is this an organisation" and "can it
// be greeted", and never asked "is this ONE PERSON" or "is this a NAME".
// The pitch writer greets the contact by name, so this was one send away from
// being the greeting of a cold email to a real veterinary practice.

const O = require(REPO + 'server/services/ownerName.js');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

const SENTENCE = 'The practice is led by Dr. Sarah Wilson, Dr. James Vetter, Dr. Amy Chen, Dr. Mark Ross and Dr. Lisa Kim';

(async () => {
  // ── REAL NAMES SURVIVE. This is the half that matters most: a rule that
  // rejects prose by rejecting anything unusual would empty the column.
  OUT.push('-- names a real person actually has --');
  const GOOD = [
    'Dana Whitfield', 'Bo Nix', 'Dr. Sarah Wilson', 'J. R. Whitfield',
    'Maria Fernanda Rodriguez de la Cruz', 'Jean-Luc de la Fontaine',
    "Mary-Kate O'Brien-Smith", 'Ana Ruiz-Vega', 'Vincent van Gogh',
    // Surnames that contain a word the prose rule looks for. The rule is
    // word-boundaried precisely so these are not casualties.
    'Les Isley', 'Marcus Owens', 'Tom Ledbetter', 'Grace Hasbrouck', 'Ada Ledford',
  ];
  for (const n of GOOD) ok(`accepted: ${n}`, O.problem(n) === null, O.problem(n));
  ok('  and each is returned unchanged by clean()', GOOD.every((n) => O.clean(n) === n), GOOD.map((n) => [n, O.clean(n)]).filter(([a, b]) => a !== b));

  // ── THE SENTENCE ───────────────────────────────────────────────────────
  OUT.push('', '-- the sentence --');
  const why = O.problem(SENTENCE, 'Wilvet South');
  ok('THE WILVET SOUTH VALUE IS REFUSED', !!why, why);
  ok('  and the reason says what is wrong with it, in words', /characters|prose|people/.test(why || ''), why);
  ok('  clean() will not guess at it', O.clean(SENTENCE, 'Wilvet South') === null);
  ok('  extract() recovers the first person it names', O.extract(SENTENCE, 'Wilvet South') === 'Sarah Wilson', O.extract(SENTENCE, 'Wilvet South'));

  OUT.push('', '-- every shape that is not one name --');
  const BAD = [
    [SENTENCE, 'a sentence naming five people'],
    ['Wilvet South is owned by Dr. Ann Lee and Dr. Bob Ray, who founded it in 2011', 'a sentence with the brand in it'],
    ['Ann Lee and Bob Ray', 'two people'],
    ['Ann Lee, Bob Ray, Cy Ng', 'three people'],
    ['Owner: Dana Whitfield', 'a label and a name'],
    ['Dana Whitfield, Owner', 'a name and a title'],
    ['Owner', 'a role with no name'],
    ['The team', 'a group'],
    ['Established 1994', 'a fact, and it has a digit'],
    ['Call 205-555-0148', 'a phone number'],
    ['', 'nothing'],
    ['   ', 'whitespace'],
  ];
  for (const [v, what] of BAD) ok(`refused (${what})`, O.problem(v, 'Wilvet South') !== null, [v, O.problem(v, 'Wilvet South')]);
  ok('the business is not its own owner', O.problem('Wilvet South', 'Wilvet South') !== null);

  // ── REPAIR, WITHOUT INVENTION ──────────────────────────────────────────
  OUT.push('', '-- repair --');
  ok('a title is stripped, not thrown away with the name', O.clean('Dana Whitfield, Owner') === 'Dana Whitfield');
  ok('a label is stripped too', O.clean('Owner: Dana Whitfield') === 'Dana Whitfield');
  ok('  and the stripped result is itself checked', O.clean('Owner: The team is large') === null);
  ok('extract() skips the business name and finds the person',
    O.extract('Wilvet South is owned by Dr. Ann Lee and Dr. Bob Ray, who founded it in 2011', 'Wilvet South') === 'Ann Lee',
    O.extract('Wilvet South is owned by Dr. Ann Lee and Dr. Bob Ray, who founded it in 2011', 'Wilvet South'));
  ok('IT NEVER INVENTS: a value with no person in it recovers nothing',
    O.extract('Established 1994', null) === null && O.extract('Owner', null) === null && O.extract('The team', null) === null);
  ok('  nor does it return the brand', O.extract('Wilvet South', 'Wilvet South') === null);

  // ── THE GATE THE CARD ACTUALLY PASSES THROUGH ──────────────────────────
  OUT.push('', '-- the card gate --');
  ok('personNameProblem now refuses the sentence', !!Q.personNameProblem(SENTENCE, 'Wilvet South'));
  ok('  and still accepts a real contact', Q.personNameProblem('Dana Whitfield', 'Wilvet South') === null);
  ok('  and still accepts one with an honorific', Q.personNameProblem('Dr. Sarah Wilson', 'Wilvet South') === null);
  ok('  the message it logs is truncated, so a 103-character value does not fill the log',
    (Q.personNameProblem(SENTENCE, 'Wilvet South') || '').indexOf('…') !== -1);
  const qsrc = src('server/services/outreachQueue.js');
  ok('the card build NORMALISES before it validates, so a good name with a title is not lost',
    /contactName: _ownerName\(top\.name, c\.brand \|\| c\.brandName\)/.test(qsrc)
    && /contactName: p \? _ownerName\(p\.name, c\.brand_name\) : null/.test(qsrc));
  ok('  through the one shared rule, not a second copy of it',
    /require\('\.\/ownerName'\)\.clean\(raw, brandName\)/.test(qsrc)
    && /require\('\.\/ownerName'\)\.problem\(n, brandName\)/.test(qsrc));
  ok('the cap is the 40 characters the report counts', O.MAX_LEN === 40);

  // ── THE CLEANUP SCRIPT ─────────────────────────────────────────────────
  OUT.push('', '-- the cleanup script --');
  const sc = src('scripts/mybrands-cleanup.js');
  ok('it reports and changes NOTHING unless told to',
    /const FIX_OWNERS = has\('--fix-owners'\)/.test(sc) && /const DEL_PLACEHOLDERS = has\('--delete-placeholders'\)/.test(sc)
    && /if \(FIX_OWNERS && problems\.length\)/.test(sc) && /if \(DEL_PLACEHOLDERS && bad\.length\)/.test(sc));
  ok('  and says so at the top when it is only looking', /MODE: report only/.test(sc));
  ok('it counts the owner fields longer than the cap, which is the number asked for',
    /LONGER THAN \$\{OWN\.MAX_LEN\} CHARACTERS/.test(sc));
  ok('it groups the placeholder rows BY THE DAY THEY WERE FOUND, which is what answers "old rows or still happening"',
    /by the day they were found/.test(sc) && /NEWEST/.test(sc) && /2026-09-16/.test(sc));
  ok('  and the day is formatted, not a Date stringified to "Fri Sep 11"', /function day\(v\)/.test(sc) && /toISOString\(\)\.slice\(0, 10\)/.test(sc));
  ok('it uses the SAME placeholder rule the nightly gate uses', /store\.placeholderReason\(c\.brand_name\)/.test(sc));
  ok('  and the same owner rule the card gate uses', /OWN\.problem\(o\.contact_name, o\.brand_name\)/.test(sc));
  ok('a deleted placeholder card also stops the draft it wrote, rather than leaving it approvable',
    /cadence_stop_reason = 'the business name was a placeholder, not a real business'/.test(sc));
  ok('it is admin-only, through the script runner',
    /'mybrands-cleanup': \{[\s\S]{0,120}?file: 'scripts\/mybrands-cleanup\.js'/.test(src('server/index.js')));

  // ── AND THE PLACEHOLDER GATE ITSELF STILL CATCHES THE THREE REPORTED ───
  OUT.push('', '-- the three names from the report --');
  const store = require(REPO + 'server/store.js');
  for (const n of ['Local Harrisburg Restaurant (independent)',
    'Local Harrisburg Barber/Salon (independent)',
    'Local Virginia Tech Fan Business (non-excluded school market)']) {
    ok(`refused today: ${n.slice(0, 44)}`, !!store.placeholderReason(n), store.placeholderReason(n));
  }
  ok('and a real business with "Local" in its name is NOT refused',
    !store.placeholderReason('Local Motion Fitness') && !store.placeholderReason('The Local Taco'));
  ok('insertCard runs that gate on every path, so nothing can write one today',
    /store\.placeholderReason \? store\.placeholderReason\(card && card\.brandName\) : null/.test(src('server/jobs/outreachQueue.js')));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('ownername: FAILED', e); process.exit(1); });
