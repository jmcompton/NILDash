'use strict';
//   node tests/everyschool.js
//
// ── EVERY US COLLEGE RESOLVES TO ITS OWN TOWN ───────────────────────────────
// services/usColleges is the Department of Education's directory (IPEDS
// HD2023): every active, degree-granting two- and four-year college. The
// resolver answers a full name from it where its own lists had no answer or a
// wrong one, and never moves an answer the lists already gave.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
const U = require(REPO + 'server/services/usColleges.js');
const R = require(REPO + 'server/services/schoolResolver.js');
const RAW = require(REPO + 'server/data/usColleges.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 400) : '')); } };
const at = (s, opts) => { const r = R.resolveSchool(s, opts); return r ? `${r.city}, ${r.state}` : null; };

OUT.push('-- the directory --');
ok('about 4,000 colleges, every state', RAW.length > 3900 && new Set(RAW.map((r) => r[2])).size >= 51, RAW.length);
ok('"St." and "Saint", commas and hyphens are the same name', U.find("St. Joseph's University") && U.find("St. Joseph's University").city === 'Philadelphia'
  && U.find('California State University, Bakersfield').city === 'Bakersfield');
ok('a listed alias answers ("CSU Bakersfield")', (U.find('CSU Bakersfield') || {}).city === 'Bakersfield');
ok('a name shared by schools in different towns is not answered', U.find('Bethel University') === null && U.find('Columbia College') === null);
ok('  unless the agent typed the state', (U.find('Bethel University', 'TN') || {}).state === 'TN');
ok('the bare name of a system is its main campus ("Ohio University" is Athens)', (U.find('Ohio University') || {}).city === 'Athens'
  && (U.find('University of Pittsburgh') || {}).city === 'Pittsburgh');
ok('a single word is never a full name', U.find('Miami') === null && U.find('State') === null);
ok('towns are spelled the way the app spells them ("St. Louis")', RAW.some((r) => r[1] === 'Saint Louis') && (U.find('Webster University') || {}).city === 'St. Louis');

OUT.push('', '-- the resolver --');
ok('St. Joseph\'s University is Philadelphia (was a Brooklyn/Long Island tie, then San Jose)', at("St. Joseph's University") === 'Philadelphia, PA', at("St. Joseph's University"));
ok('Saint Joseph\'s University is Philadelphia (was fuzzed to West Hartford)', at("Saint Joseph's University") === 'Philadelphia, PA', at("Saint Joseph's University"));
ok('a note in parentheses the directory cannot read is left to the lists', at("St. Joseph's University (Brooklyn)") !== 'Philadelphia, PA');
ok('a junior college no list carried resolves', at('Iowa Western Community College') === 'Council Bluffs, IA' && at('Coffeyville Community College') === 'Coffeyville, KS');
ok('CSU Bakersfield resolves to its town with its state', at('California State University, Bakersfield') === 'Bakersfield, CA');
ok('answers the lists already gave do not move', at('Keiser University') === 'West Palm Beach, FL' && at('Lindenwood University') === 'St. Charles, MO'
  && at('Morningside University') === 'Sioux City, IA' && at('Miami (Ohio)') === 'Oxford, OH', [at('Keiser University'), at('Lindenwood University'), at('Miami (Ohio)')]);
ok('the shipped scan no longer puts a full name in another state by substring', at('Arkansas State University-Beebe') === 'Beebe, AR' && at('Central Alabama Community College') === 'Alexander City, AL',
  [at('Arkansas State University-Beebe'), at('Central Alabama Community College')]);
R.learn('Iowa Western Community College', { city: 'Omaha', state: 'NE' });
ok('a wrong LEARNED lookup gives way to the directory on a full name', at('Iowa Western Community College') === 'Council Bluffs, IA', at('Iowa Western Community College'));
R.unlearn('Iowa Western Community College');
R.learn('Ff Unknown Academy of Arts', { city: 'Boise', state: 'ID' });
ok('  and a learned school the directory does not have still stands', at('Ff Unknown Academy of Arts') === 'Boise, ID');
R.unlearn('Ff Unknown Academy of Arts');
ok('a caller passing its own map does not reach the directory', at("Saint Joseph's University", { map: {}, lookup: () => null, mapNames: [], ignoreAmbiguity: true }) === null);

let right = 0;
for (const r of RAW) {
  const x = R.resolveSchool(r[0].replace(/\s*-\s*Main Campus$/i, ''));
  if (x && x.state === r[2]) right++;
}
ok(`at least 90% of every US college resolves in its own state by its official name (${right} of ${RAW.length})`, right / RAW.length >= 0.9, right);

const pass = OUT.filter((l) => l.startsWith('PASS')).length;
console.log(OUT.join('\n'));
console.log(`\n${pass} passed\nfailures: ${F}`);
process.exit(F ? 1 : 0);
