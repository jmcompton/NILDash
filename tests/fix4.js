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
const aiPath=require.resolve(REPO + 'server/ai.js');
require.cache[aiPath]={id:aiPath,filename:aiPath,loaded:true,exports:{runSourceWaves:async()=>({results:[]}),webSearchJson:async()=>({text:''}),oneShot:async()=>''}};
const sp=require(REPO + 'server/services/staffPage.js');
const pm=require(REPO + 'server/services/programMap.js');
let f=0; const chk=(n,c)=>{ if(!c){f++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };

console.log('-- fix 1: parser edge cases (the real rows you saw) --');
chk('"Email Address" is not a name', sp.looksLikeName('Email Address')===false);
chk('"Sr. Assistant Athletic Trainer: Football" is not a name',
    sp.looksLikeName('Sr. Assistant Athletic Trainer: Football')===false);
chk('"Director of Football Operations" is not a name', sp.looksLikeName('Director of Football Operations')===false);
chk('a real name still passes', sp.looksLikeName('Dave Caldwell')===true);
chk('a hyphenated name passes', sp.looksLikeName('Mary-Kate O\'Brien')===true);

console.log('\n-- fix 4: the titles that were missed --');
const R=(t)=>pm._roleOf({role:'other',title:t});
chk('Assistant AD / Football Chief of Staff -> GM bucket', R('Assistant Athletic Director/Football Chief of Staff')==='general_manager');
chk('Sr. Director of Football Operations -> GM bucket', R('Sr. Director of Football Operations')==='general_manager');
chk('Chief of Staff to HC & General Manager -> GM bucket', R('Chief of Staff to Head Coach & General Manager')==='general_manager');
chk('Executive Director - Player Personnel -> player personnel', R('Executive Director - Player Personnel')==='player_personnel');
chk('Director of Recruiting Operations -> recruiting', R('Director of Recruiting Operations')==='recruiting');
chk('Head Coach still head coach', R('Head Coach')==='head_coach');
chk('Athletic Trainer stays untagged', R('Sr. Assistant Athletic Trainer')===null);

console.log('\n-- fix 4: seniority ranking, no arbitrary pick --');
const staff=[
 {name:'Person One',title:'Assistant General Manager'},
 {name:'Person Two',title:'General Manager'},
 {name:'Person Three',title:'Director of Recruiting Operations'},
 {name:'Person Four',title:'Assistant Director of Recruiting'},
 {name:'Person Five',title:'Recruiting Coordinator'},
 {name:'Person Six',title:'Head Coach'},
 {name:'Person Seven',title:'Equipment Manager'},
];
const recs=pm.recordsFromStaffPage('Test',staff,'https://x.com/football/staff');
chk('EVERY staff member stored, not just 5 roles', recs.length===7);
const gm=recs.filter(r=>r.role==='general_manager').sort((a,b)=>a.role_rank-b.role_rank);
chk('GM outranks Assistant GM', gm[0].name==='Person Two' && gm[1].name==='Person One');
chk('both GMs kept, not one arbitrary pick', gm.length===2);
chk('only the senior GM is the key contact', gm[0].is_key_contact===true && gm[1].is_key_contact===false);
const rec=recs.filter(r=>r.role==='recruiting').sort((a,b)=>a.role_rank-b.role_rank);
chk('all 3 recruiting people kept and ranked', rec.length===3 && rec[0].name==='Person Three');
const untagged=recs.filter(r=>r.role==='staff');
chk('equipment manager stored as untagged staff', untagged.length===1 && untagged[0].name==='Person Seven');
chk('untagged staff still searchable with school+source', untagged[0].source_url && untagged[0].school==='Test');
console.log('\nfailures: '+f);
