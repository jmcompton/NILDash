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
  webSearchJson: async () => ({ text: '', searches: 0, outTokens: 0 }),
} };
const pm = require(REPO + 'server/services/programMap.js');
let f=0; const chk=(n,c)=>{ if(!c){f++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };
console.log('-- tier classification --');
chk('official staff directory = A', pm.classifyTier('https://rolltide.com/staff-directory/','Alabama')==='A');
chk('official coaches page = A',    pm.classifyTier('https://auburntigers.com/sports/football/coaches','Auburn')==='A');
chk('school .edu staff page = A',   pm.classifyTier('https://athletics.uga.edu/staff/leadership','Georgia')==='A');
chk('official news post = B',       pm.classifyTier('https://utsports.com/news/2024/1/5/hire','Tennessee')==='B');
chk('linkedin = C',                 pm.classifyTier('https://www.linkedin.com/in/x','LSU')==='C');
chk('on3 = C',                      pm.classifyTier('https://www.on3.com/teams/lsu-tigers/news/x/','LSU')==='C');
chk('collective site = B',          pm.classifyTier('https://floridavictorious.com/leadership','Florida')==='B');
chk('random blog = D',              pm.classifyTier('https://fanblog.wordpress.com/p','Missouri')==='D');
chk('another school domain != A',   pm.classifyTier('https://rolltide.com/staff-directory/','Auburn')!=='A');
console.log('\n-- date parsing --');
chk('ISO date parses', pm.parseDate('2026-07-15') instanceof Date);
chk('undated -> null', pm.parseDate(null)===null);
chk('junk -> null', pm.parseDate('sometime last year')===null);
chk('2021 is stale', pm.isStale(Date.parse('2021-03-01'), Date.parse('2026-08-10'))===true);
chk('2026 is fresh', pm.isStale(Date.parse('2026-06-01'), Date.parse('2026-08-10'))===false);
chk('undated is not stale', pm.isStale(null, Date.parse('2026-08-10'))===false);
console.log('\nfailures: '+f);
