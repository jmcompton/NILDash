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
const aiPath = require.resolve(REPO + 'server/ai.js');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  runSourceWaves: async () => ({ results: [], ms: 0, waveSize: 3, wavesRun: 0 }),
  webSearchJson: async () => ({ text: '', searches: 0, outTokens: 0 }) } };
const pm = require(REPO + 'server/services/programMap.js');
let f=0; const chk=(n,c)=>{ if(!c){f++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };

console.log('-- the actual Texas A&M bug --');
chk('Nate Collins track GM detected as track',
  pm.detectSport('track','Chief of Staff and General Manager, Track and Field','https://12thman.com/news/2026/7/1/burrell-names-collins')==='track');
chk('title alone gives it away',
  pm.detectSport(null,'General Manager, Track & Field','https://12thman.com/staff-directory')==='track');
chk('Derek Miller football GM detected as football',
  pm.detectSport('football','General Manager, Football','https://12thman.com/sports/football/staff')==='football');

console.log('\n-- other sports are caught --');
for (const [sp,title] of [['baseball','Director of Baseball Operations'],['mens_basketball','Basketball General Manager'],
                          ['soccer','Director of Soccer Operations'],['softball','Softball Director of Player Personnel'],
                          ['volleyball','Volleyball GM'],['swimming','Director of Swimming and Diving Ops']])
  chk(sp+' caught', pm.detectSport(null,title,'https://x.com/staff-directory')===sp);

console.log('\n-- football wins when both appear --');
chk('"Director of Football Operations" on a dept page = football',
  pm.detectSport(null,'Director of Football Operations','https://12thman.com/staff-directory')==='football');
chk('unstated stays null (not dropped by the sport rule)',
  pm.detectSport(null,'General Manager','https://12thman.com/staff-directory')===null);

console.log('\n-- tier A gate: dept-wide directory is not enough --');
chk('bare "General Manager" on /staff-directory is NOT football-scoped',
  pm.footballScoped('General Manager','https://12thman.com/staff-directory')===false);
chk('football in the TITLE is enough',
  pm.footballScoped('Football General Manager','https://12thman.com/staff-directory')===true);
chk('football in the PATH is enough',
  pm.footballScoped('General Manager','https://12thman.com/sports/football/staff-directory')===true);
chk('head coach on a football path is scoped',
  pm.footballScoped('Head Coach','https://12thman.com/sports/football/coaches')===true);
console.log('\nfailures: '+f);
