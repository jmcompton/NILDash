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
// Stub ai.js in the require cache: no node_modules here, but programMap's LOGIC
// (recency, dedupe, reach) is pure and is what we are testing.
const aiPath = require.resolve(REPO + 'server/ai.js');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  runSourceWaves: async () => ({ results: [], ms: 0, waveSize: 3, wavesRun: 0 }),
  webSearchJson: async () => ({ text: '', searches: 0, outTokens: 0, apiMs: 0, citations: [] }),
} };
const pm=require(REPO + 'server/services/programMap.js');
const NOW=Date.parse('2026-08-10');
const ms=(d)=>Date.parse(d);
let f=0; const chk=(n,c)=>{ if(!c){f++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };
const S=(o)=>Object.assign({tier:'C',source:'news',sourceUrl:'https://on3.com/x',dateMs:null,isFormer:false},o);

console.log('-- staleness gate --');
chk('2021 Tier A alone = stale, NOT confident',
  pm._assess([S({tier:'A',source:'press',sourceUrl:'https://lsusports.net/staff-directory/',dateMs:ms('2021-03-01')})],NOW)==='stale');
chk('fresh Tier A = confident',
  pm._assess([S({tier:'A',source:'athletics_directory',sourceUrl:'https://rolltide.com/staff-directory/',dateMs:ms('2026-06-01')})],NOW)==='confident');
chk('UNDATED Tier A = confident (a live directory has no date)',
  pm._assess([S({tier:'A',source:'athletics_directory',sourceUrl:'https://rolltide.com/staff-directory/',dateMs:null})],NOW)==='confident');
chk('two fresh independent B/C = confident',
  pm._assess([S({tier:'C',source:'linkedin',sourceUrl:'https://linkedin.com/in/a',dateMs:ms('2026-05-01')}),
              S({tier:'C',source:'news',sourceUrl:'https://on3.com/y',dateMs:ms('2026-04-01')})],NOW)==='confident');
chk('one fresh C alone = likely',
  pm._assess([S({dateMs:ms('2026-05-01')})],NOW)==='likely');

console.log('\n-- recency ordering (Florida 3-GM case) --');
const caldwell=[S({tier:'A',source:'press',sourceUrl:'https://floridagators.com/news/2026/3/1/a',dateMs:ms('2026-03-01')})];
const polk=[S({tier:'A',source:'press',sourceUrl:'https://floridagators.com/news/2024/2/1/b',dateMs:ms('2024-02-01')})];
const lafrance=[S({tier:'A',source:'press',sourceUrl:'https://floridagators.com/news/2022/1/1/c',dateMs:ms('2022-01-01')})];
const ranked=[polk,lafrance,caldwell].sort(pm._byRecency);
chk('newest press release ranks first', pm._newestMs(ranked[0])===ms('2026-03-01'));
chk('oldest ranks last', pm._newestMs(ranked[2])===ms('2022-01-01'));
chk('a 2022 predecessor is stale, so cannot be confident', pm._assess(lafrance,NOW)==='stale');
chk('dated beats undated', pm._byRecency([S({dateMs:ms('2026-01-01')})],[S({dateMs:null})])<0);

console.log('\n-- cross-school dedupe (Breske / Thomas cases) --');
const recs=[
 {school:'Missouri',role:'general_manager',role_label:'General Manager',name:'Jake Breske',status:'current',confidence:'confident',source_date:'2025-12-10',source_tier:'A'},
 {school:'Tennessee',role:'general_manager',role_label:'General Manager',name:'Jake Breske',status:'current',confidence:'confident',source_date:'2024-06-01',source_tier:'B'},
 {school:'Ole Miss',role:'general_manager',role_label:'General Manager',name:'Austin Thomas',status:'current',confidence:'confident',source_date:'2026-02-01',source_tier:'A'},
 {school:'LSU',role:'general_manager',role_label:'General Manager',name:'Austin Thomas',status:'current',confidence:'confident',source_date:'2021-05-01',source_tier:'B'},
];
const d=pm.dedupeAcrossSchools(recs);
chk('2 collisions detected', d.collisions===2);
chk('Missouri (Dec 2025) kept', recs[0].status==='current');
chk('Tennessee (2024) demoted', recs[1].status==='previous');
chk('Ole Miss (2026) kept', recs[2].status==='current');
chk('LSU (2021) demoted', recs[3].status==='previous');

console.log('\n-- reach fallback --');
const c={football_office_phone:'(205) 348-3600'};
chk('no direct contact -> office line + ask for',
  pm.reachVia({name:'Jane Doe',role:'general_manager'},c).includes('ask for Jane Doe'));
chk('direct email wins', pm.reachVia({name:'X',email:'x@y.com'},c).startsWith('Email'));
chk('nothing at all is still honest', pm.reachVia({name:'X'},{}).includes('No published contact'));
console.log('\nfailures: '+f);
