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
  runSourceWaves: async () => ({ results: [] }), webSearchJson: async () => ({ text: '' }) } };
const pm = require(REPO + 'server/services/programMap.js');
let f=0; const chk=(n,c)=>{ if(!c){f++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };

console.log('-- regression 2: Tennessee Billy High --');
chk('"Executive Director of Football Management" -> general_manager',
  pm._roleOf({role:'other',title:'Executive Director of Football Management'})==='general_manager');
chk('model mislabels it collective_director -> corrected to GM',
  pm._roleOf({role:'collective_director',title:'Executive Director of Football Management'})==='general_manager');
chk('a REAL collective role still classifies',
  pm._roleOf({role:'other',title:'Executive Director, Volunteer Club NIL Collective'})==='collective_director');
chk('plain "Executive Director" of a collective still works',
  pm._roleOf({role:'collective_director',title:'Executive Director'})==='collective_director');
chk('head coach unaffected', pm._roleOf({role:'other',title:'Head Coach'})==='head_coach');
chk('player personnel unaffected', pm._roleOf({role:'other',title:'Director of Player Personnel'})==='player_personnel');

console.log('\n-- regression 3: Ole Miss MacKenzie Ray --');
const ms=(d)=>Date.parse(d);
const S=(o)=>Object.assign({tier:'C',source:'news',sourceUrl:'https://si.com/x',dateMs:null,isFormer:false},o);
const ray=[S({tier:'A',source:'athletics_directory',sourceUrl:'https://olemisssports.com/sports/football/roster/staff',dateMs:null})];
const bolden=[S({tier:'C',source:'news',sourceUrl:'https://si.com/lsu-gm-hire',dateMs:ms('2026-06-01')})];
const ranked=[bolden,ray].sort(pm._byRecency);
chk('Tier A directory ranks FIRST despite being undated', ranked[0]===ray);
chk('dated news article is the runner-up', ranked[1]===bolden);
const two=[[S({tier:'A',dateMs:ms('2024-01-01'),source:'athletics_directory'})],[S({tier:'A',dateMs:ms('2026-01-01'),source:'athletics_directory'})]].sort(pm._byRecency);
chk('between two Tier A records the NEWER still wins', pm._newestMs(two[0])===ms('2026-01-01'));
console.log('\nfailures: '+f);
