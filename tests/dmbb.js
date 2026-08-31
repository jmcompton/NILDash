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
// decisionMaker, basketball rules. The football lists must be untouched and the
// basketball ones must not simply be football's with a different name.
const dm = require(REPO + 'server/services/decisionMaker.js');
let f = 0; const chk = (n, c) => { if (!c) { f++; console.log('  FAIL ' + n); } else console.log('  PASS ' + n); };
const keepBB = (t) => dm.isDecisionMaker(t, 'mens_basketball');
const keepFB = (t) => dm.isDecisionMaker(t, 'football');

console.log('-- basketball decision seats are kept --');
for (const t of ['Head Coach', "Head Men's Basketball Coach", 'General Manager',
  'Director of Basketball Operations', 'Assistant Coach', 'Associate Head Coach',
  'Director of Player Personnel', 'Director of Recruiting', 'Chief of Staff',
  'Director of Player Development', 'Assistant Director of Basketball Operations'])
  chk(`kept: ${t}`, keepBB(t));

console.log('\n-- basketball support and development seats are dropped --');
for (const t of ['Video Coordinator', 'Director of Basketball Analytics', 'Graduate Assistant',
  'Student Manager', 'Athletic Trainer', 'Director of Sports Nutrition',
  'Assistant Athletic Director for Communications', 'Quality Control Assistant'])
  chk(`dropped: ${t}`, !keepBB(t));

console.log('\n-- the two sports genuinely differ --');
chk('assistant coach: STRONG on basketball', dm.classifyTitle('Assistant Coach', 'mens_basketball').reason === 'basketball decision maker');
chk('assistant coach: not strong on football', dm.classifyTitle('Assistant Coach', 'football').reason !== 'football decision maker');
chk('"Offensive Line Coach" is kept on football', keepFB('Offensive Line Coach'));
chk('"Offensive Line Coach" is DROPPED on basketball', !keepBB('Offensive Line Coach'));
chk('"Director of Basketball Operations" kept on basketball', keepBB('Director of Basketball Operations'));
chk('"Director of Football Operations" kept on football', keepFB('Director of Football Operations'));
chk('"Director of Football Operations" not a basketball seat', !keepBB('Director of Football Operations'));

console.log('\n-- basketball position groups --');
for (const t of ['Guards Coach', 'Post Development Coach', 'Perimeter Coach', 'Big Men Coach'])
  chk(`kept: ${t}`, keepBB(t));
chk('"Quarterbacks Coach" is not a basketball seat', !keepBB('Quarterbacks Coach'));

console.log('\n-- hard drops outrank everything in both sports --');
for (const t of ['Graduate Assistant Coach', 'Student Assistant Coach', 'Recruiting Analyst'])
  for (const sp of ['football', 'mens_basketball'])
    chk(`${sp}: dropped ${t}`, !dm.isDecisionMaker(t, sp));

console.log('\n-- defaults and back-compat --');
chk('no sport argument behaves as football', dm.isDecisionMaker('Offensive Line Coach') === true);
chk('unknown sport falls back to football', dm.isDecisionMaker('Offensive Line Coach', 'quidditch') === true);
chk('"basketball" alias resolves to mens_basketball', dm.classifyTitle('Assistant Coach', 'basketball').keep === true);
chk('STRONG_KEEP export is still football\'s', dm.STRONG_KEEP === dm.FOOTBALL_STRONG_KEEP);
chk('WEAK_KEEP export is still football\'s', dm.WEAK_KEEP === dm.FOOTBALL_WEAK_KEEP);

console.log('\n-- partition reads a row\'s own sport --');
const mixed = [
  { name: 'A One', title: 'Assistant Coach', sport: 'mens_basketball' },
  { name: 'B Two', title: 'Assistant Coach', sport: 'football' },
];
const part = dm.partition(mixed);
chk('basketball assistant shown, football assistant hidden',
  part.shown.length === 1 && part.shown[0].name === 'A One');
const bbAll = dm.partition([{ name: 'C Three', title: 'Assistant Coach' }], 'mens_basketball');
chk('partition sport argument applies when the row has none', bbAll.shown.length === 1);

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
