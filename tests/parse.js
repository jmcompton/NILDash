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
const sp = require(REPO + 'server/services/staffPage.js');
let f=0; const chk=(n,c)=>{ if(!c){f++;console.log('  FAIL '+n);} else console.log('  PASS '+n); };

// SYNTHETIC fixtures with obviously fake names. I will not invent real staff.
const sidearmTable = `
<html><body><script>var x=1;</script>
<table class="sidearm-table">
<tr><th>Name</th><th>Title</th><th>Email</th><th>Phone</th></tr>
<tr><td><a href="/staff/1">Testcase Alpha</a></td><td>Head Coach</td>
    <td><a href="mailto:alpha@example.edu">alpha@example.edu</a></td>
    <td><a href="tel:3525550101">(352) 555-0101</a></td></tr>
<tr><td><a href="/staff/2">Testcase Bravo</a></td><td>General Manager, Football</td>
    <td><a href="mailto:bravo@example.edu">bravo@example.edu</a></td><td></td></tr>
<tr><td>Testcase Charlie</td><td>Director of Player Personnel</td><td></td>
    <td><a href="tel:3525550103">(352) 555-0103</a></td></tr>
<tr><td>Testcase Delta</td><td>Director of Recruiting</td><td></td><td></td></tr>
<tr><td>Testcase Echo</td><td>Assistant Athletic Trainer</td><td></td><td></td></tr>
<tr><td>Testcase Foxtrot</td><td>Offensive Coordinator</td><td></td><td></td></tr>
</table></body></html>`;

const cardMarkup = `
<ul>
 <li class="sidearm-staff-member">
   <h3><a href="/x">Testcase Golf</a></h3><span class="title">Head Coach</span>
   <a href="mailto:golf@example.edu">Email</a>
 </li>
 <li class="sidearm-staff-member">
   <h3>Testcase Hotel</h3><span class="title">Executive Director of Football Management</span>
 </li>
</ul>`;

console.log('-- table parse --');
const a = sp.parseStaffHtml(sidearmTable, 'https://example.edu/sports/football/coaches');
chk('all 6 staff parsed, headers skipped', a.length===6);
chk('name + title read', a[0].name==='Testcase Alpha' && a[0].title==='Head Coach');
chk('mailto captured', a[0].email==='alpha@example.edu');
chk('tel captured', a[0].phone && a[0].phone.includes('555-0101'));
chk('no email is null, never guessed', a[3].email===null);
chk('script content excluded', !JSON.stringify(a).includes('var x'));

console.log('\n-- card parse --');
const b = sp.parseStaffHtml(cardMarkup, 'https://example.edu/staff');
chk('card markup parsed', b.length===2);
chk('card title read', b[1].title==='Executive Director of Football Management');

console.log('\n-- role matching off the page (uses the fixed regexes) --');
const aiPath = require.resolve(REPO + 'server/ai.js');
require.cache[aiPath]={id:aiPath,filename:aiPath,loaded:true,exports:{runSourceWaves:async()=>({results:[]}),webSearchJson:async()=>({text:''}),oneShot:async()=>''}};
const pm = require(REPO + 'server/services/programMap.js');
const recs = pm.recordsFromStaffPage('Florida', a, 'https://example.edu/sports/football/coaches');
const byRole = Object.fromEntries(recs.map(r=>[r.role, r.name]));
chk('head coach matched', byRole.head_coach==='Testcase Alpha');
chk('GM matched', byRole.general_manager==='Testcase Bravo');
chk('player personnel matched', byRole.player_personnel==='Testcase Charlie');
chk('recruiting matched', byRole.recruiting==='Testcase Delta');
chk('trainer and coordinator NOT matched to a role', !Object.values(byRole).includes('Testcase Echo'));
chk('every staff-page record is Tier A confident football', recs.every(r=>r.source_tier==='A'&&r.confidence==='confident'&&r.sport==='football'));
chk('email carried with its source url', recs.find(r=>r.role==='head_coach').email_source_url!==null);

console.log('\n-- diff = the staff-change alert --');
const before=[{name:'Testcase Alpha',title:'Head Coach'},{name:'Testcase Bravo',title:'General Manager'}];
const after =[{name:'Testcase Alpha',title:'Head Coach'},{name:'Testcase India',title:'General Manager'}];
const d=sp.diffStaff(before,after);
chk('departure detected', d.removed.length===1 && d.removed[0].name==='Testcase Bravo');
chk('arrival detected', d.added.length===1 && d.added[0].name==='Testcase India');
const d2=sp.diffStaff(before,[{name:'Testcase Alpha',title:'Head Coach'},{name:'Testcase Bravo',title:'Executive Director of Football Management'}]);
chk('promotion detected as a title change', d2.changed.length===1);
chk('same page twice = no changes', sp.diffStaff(before,before).added.length===0);
chk('hash is stable for the same list', sp.hashStaff(before)===sp.hashStaff(before.slice().reverse()));
console.log('\nfailures: '+f);
