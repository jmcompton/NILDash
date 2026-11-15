'use strict';
// Field hockey is its own sport. A bare "hockey" canonicalises to ice hockey,
// and before "field hockey" was in SPORT_WORDS the fact check read the tail
// word alone: every CORRECT pitch for a field hockey athlete ("plays field
// hockey") was refused as 'says "hockey" but the stored sport is "Field
// Hockey"'. On 2026-11-15 that refused all 7 businesses for one athlete.
//
//   node tests/fieldhockey.js
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const pw = require(REPO + 'server/services/pitchWriter.js');
let fails = 0;
function ok(l, c, g) { if (c) console.log('  PASS ' + l); else { console.log('  FAIL ' + l + '  got=' + JSON.stringify(g)); fails++; } }
const probs = (m, a) => pw.verifyAthleteFacts(m, a).problems;
const FH = { name: 'Maddie Niles', firstName: 'Maddie', sport: 'Field Hockey', athleteType: 'college' };
const IH = { name: 'Max Murray', firstName: 'Max', sport: 'Ice Hockey', athleteType: 'college' };
const HK = { name: 'Max Murray', firstName: 'Max', sport: 'Hockey', athleteType: 'college' };
const BV = { name: 'Ann Lee', firstName: 'Ann', sport: 'Beach Volleyball', athleteType: 'college' };

console.log('-- the right sport passes --');
let p;
p = probs('Maddie Niles plays field hockey at Bowdoin.', FH); ok('"plays field hockey" for a Field Hockey athlete', p.length === 0, p);
p = probs('Maddie Niles is a field hockey player at Bowdoin.', FH); ok('"a field hockey player" passes', p.length === 0, p);
p = probs('Max Murray plays hockey for Colby.', IH); ok('"hockey" for Ice Hockey still passes', p.length === 0, p);
p = probs('Max Murray plays ice hockey for Colby.', HK); ok('"ice hockey" for a stored "Hockey" passes', p.length === 0, p);
p = probs('Ann Lee plays beach volleyball at TCU.', BV); ok('"beach volleyball" passes', p.length === 0, p);

console.log('-- the wrong sport is still caught --');
p = probs('Maddie Niles plays ice hockey at Bowdoin.', FH); ok('"ice hockey" for Field Hockey refused', p.length === 1, p);
p = probs('Max Murray plays field hockey for Colby.', IH); ok('"field hockey" for Ice Hockey refused', p.length === 1, p);
p = probs('Maddie Niles plays soccer at Bowdoin.', FH); ok('"soccer" for Field Hockey refused', p.length === 1, p);

console.log('-- the repair rewrites toward the record, cleanly --');
let r;
r = pw.alignSport('Maddie Niles plays ice hockey at Bowdoin.', FH);
ok('ice hockey -> field hockey', r.text === 'Maddie Niles plays field hockey at Bowdoin.', r.text);
r = pw.alignSport('Maddie Niles plays field hockey at Bowdoin.', FH);
ok('a correct field hockey draft is untouched', r.changed === false && r.text === 'Maddie Niles plays field hockey at Bowdoin.', r);
r = pw.alignSport('Max Murray plays basketball for Colby.', IH);
ok('basketball -> ice hockey, lower case mid-sentence', r.text === 'Max Murray plays ice hockey for Colby.', r.text);
r = pw.alignSport('Maddie Niles plays hockey at Bowdoin.', FH);
ok('bare hockey -> field hockey, no doubled word', r.text === 'Maddie Niles plays field hockey at Bowdoin.', r.text);
p = probs(r.text, FH); ok('and the repaired draft passes the check', p.length === 0, p);

console.log('\nfailures: ' + fails);
process.exit(fails ? 1 : 0);
