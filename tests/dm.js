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
const dm = require(REPO + 'server/services/decisionMaker.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}
const keep = (t) => ok(`KEEP  ${t}`, dm.isDecisionMaker(t) === true, dm.classifyTitle(t));
const drop = (t) => ok(`DROP  ${t}`, dm.isDecisionMaker(t) === false, dm.classifyTitle(t));

console.log('-- football operations leadership --');
['General Manager', 'Assistant General Manager', 'Chief of Staff',
 'Director of Football Operations', 'Senior Director of Football Operations',
 'President of Football Operations', 'Executive Director of Football Management',
 'Director of Football Administration'].forEach(keep);

console.log('-- personnel and scouting --');
['Director of Player Personnel', 'Assistant Director of Player Personnel',
 'Director of Player Personnel and Scouting', 'Director of College Personnel',
 'Director of High School Personnel', 'Director of Pro Personnel',
 'Assistant Director of Scouting'].forEach(keep);

console.log('-- recruiting --');
['Director of Recruiting', 'Executive Director of Recruiting',
 'Director of Recruiting Operations', 'Director of Recruiting Strategy',
 'Assistant Director of Recruiting', 'Recruiting Coordinator'].forEach(keep);

console.log('-- coaches --');
['Head Coach', 'Head Football Coach', 'Offensive Coordinator', 'Defensive Coordinator',
 'Special Teams Coordinator', 'Co-Offensive Coordinator',
 'Quarterbacks Coach', 'Wide Receivers Coach', 'Running Backs Coach',
 'Offensive Line Coach', 'Defensive Line Coach', 'Linebackers Coach',
 'Cornerbacks Coach', 'Safeties Coach', 'Tight Ends Coach',
 'Associate Head Coach'].forEach(keep);

console.log('-- player development and relationships --');
['Director of Player Development', 'Director of Player Engagement',
 'Director of Player Relations', 'Assistant Director of Player Development'].forEach(keep);

console.log('-- NIL, brand, revenue inside the program --');
['Director of NIL', 'General Manager, NIL', 'Director of Brand Partnerships',
 'Director of Revenue and Partnerships', 'NIL Coordinator'].forEach(keep);

console.log('-- the noise an agent does not want --');
['Quality Control Coach', 'Offensive Quality Control', 'Defensive Quality Control',
 'Graduate Assistant', 'Graduate Assistant - Defense', 'Student Assistant',
 'Student Manager', 'Recruiting Intern', 'Football Operations Intern',
 'Video Coordinator', 'Director of Video Operations', 'Assistant Video Coordinator',
 'Equipment Manager', 'Director of Equipment Operations', 'Assistant Equipment Manager',
 'Director of Sports Nutrition', 'Sports Dietitian',
 'Head Athletic Trainer', 'Associate Athletic Trainer', 'Assistant Athletic Trainer',
 'Director of Sports Medicine',
 'Director of Strength and Conditioning', 'Assistant Strength and Conditioning Coach',
 'Director of Football Performance', 'Sports Performance Coach',
 'Creative Director', 'Director of Creative Media', 'Graphic Designer',
 'Team Photographer', 'Director of Photography',
 'Director of Football Communications', 'Assistant Director of Communications',
 'Director of Academic Services', 'Academic Coordinator',
 'Director of Travel', 'Travel Coordinator',
 'Director of Ticket Operations', 'Business Manager'].forEach(drop);

console.log('-- the hard cases: a keep word inside a support title --');
drop('Recruiting Analyst');
drop('Offensive Analyst');
drop('Defensive Analyst');
drop('Personnel Analyst');
drop('Scouting Analyst');
drop('Player Personnel Intern');
drop('Recruiting Graduate Assistant');
drop('Quality Control - Recruiting');
keep('Director of Recruiting');
keep('Director of Player Personnel');
ok('an analyst with a directorship is still dropped as support',
  dm.isDecisionMaker('Director of Football Analytics') === false,
  dm.classifyTitle('Director of Football Analytics'));

console.log('-- edge cases --');
ok('empty title drops', dm.isDecisionMaker('') === false, null);
ok('null title drops', dm.isDecisionMaker(null) === false, null);
ok('the reason for a missing title is specific',
  dm.classifyTitle(null).reason === 'no title published', dm.classifyTitle(null));
ok('every drop carries a reason',
  ['Video Coordinator', 'Graduate Assistant', 'Recruiting Analyst', 'Custodian']
    .every((t) => !!dm.classifyTitle(t).reason), null);

console.log('-- a realistic 81-person LSU-shaped roster lands in the target band --');
// Proportions taken from what an SEC staff page actually contains: a handful of
// decision makers and a long tail of support and development seats.
const ROSTER = [
  'Head Football Coach', 'Associate Head Coach', 'Offensive Coordinator', 'Defensive Coordinator',
  'Special Teams Coordinator', 'Quarterbacks Coach', 'Running Backs Coach', 'Wide Receivers Coach',
  'Tight Ends Coach', 'Offensive Line Coach', 'Defensive Line Coach', 'Linebackers Coach',
  'Cornerbacks Coach', 'Safeties Coach',
  'General Manager', 'Assistant General Manager', 'Chief of Staff',
  'Director of Football Operations', 'Director of Player Personnel',
  'Director of Recruiting', 'Director of Recruiting Operations',
  'Director of Player Development', 'Director of NIL',
];
const NOISE = [];
for (let i = 0; i < 20; i++) NOISE.push('Offensive Quality Control');
for (let i = 0; i < 12; i++) NOISE.push('Graduate Assistant');
for (let i = 0; i < 8; i++) NOISE.push('Student Assistant');
for (let i = 0; i < 6; i++) NOISE.push('Recruiting Analyst');
for (let i = 0; i < 4; i++) NOISE.push('Assistant Athletic Trainer');
for (let i = 0; i < 3; i++) NOISE.push('Assistant Video Coordinator');
for (let i = 0; i < 3; i++) NOISE.push('Assistant Equipment Manager');
for (let i = 0; i < 2; i++) NOISE.push('Sports Dietitian');
const all = ROSTER.concat(NOISE).map((t, i) => ({ name: 'Fixture Person ' + i, title: t }));
ok('the fixture is 81 people', all.length === 81, all.length);
const part = dm.partition(all);
ok(`shows ${part.shown.length}, which is inside the 15 to 25 target`,
  part.shown.length >= 15 && part.shown.length <= 25, part.shown.length);
ok('hides the rest', part.hidden.length === 81 - part.shown.length, part.hidden.length);
ok('every decision maker survived', part.shown.length === ROSTER.length,
  { shown: part.shown.length, expected: ROSTER.length });
ok('no quality control survived',
  !part.shown.some((p) => /quality control/i.test(p.title)), null);
ok('no graduate assistant survived',
  !part.shown.some((p) => /graduate assistant/i.test(p.title)), null);
ok('the head coach survived', part.shown.some((p) => p.title === 'Head Football Coach'), null);
ok('the GM survived', part.shown.some((p) => p.title === 'General Manager'), null);

console.log('-- email is NEVER a criterion: the Alabama case --');
const alabama = [
  { name: 'Fixture Aldridge', title: 'General Manager', email: null },
  { name: 'Fixture Bramwell', title: 'Head Football Coach', email: null },
  { name: 'Fixture Castellan', title: 'Director of Player Personnel', email: null },
  { name: 'Fixture Danforth', title: 'Video Coordinator', email: 'video@x.edu' },
];
const al = dm.partition(alabama);
ok('all three contactless decision makers are kept', al.shown.length === 3, al.shown.map((p) => p.title));
ok('the contactable support person is still dropped',
  !al.shown.some((p) => p.title === 'Video Coordinator'), null);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
