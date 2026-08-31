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
const fs=require('fs');
const src=fs.readFileSync(REPO + 'server/ai.js','utf8');
const rankSrc=src.match(/function _contactAuthorityRank\(title\) \{[\s\S]*?\n\}/)[0];
const rootSrc=src.match(/function _rootDomain\(url\) \{[\s\S]*?\n\}/)[0];
const ordSrc=src.match(/const MANUAL_SOURCE_ORDER = \[[^\]]*\];/)[0];
const m={}; new Function('module', rankSrc+'\n'+rootSrc+'\n'+ordSrc+'\nmodule.r=_contactAuthorityRank;module.rd=_rootDomain;module.o=MANUAL_SOURCE_ORDER;')(m);
const { buildContactLadder } = require(REPO + 'server/services/contactLadder.js');
const W=3;
console.log('wave1:', m.o.slice(0,W).join(', '));
console.log('wave2:', m.o.slice(W,2*W).join(', '));
console.log('wave3:', m.o.slice(2*W).join(', '));
console.log('\n-- channel priority (email > linkedin > instagram > direct phone > main line) --');
const MAIN='(205) 555-0100';
const mk=(over)=>({contacts:[Object.assign({name:'Pat Owner',title:'Owner',source:'site',sourceUrl:'https://biz.com/about',confidence:'high'},over)],
  businessPhone:MAIN, website:'https://biz.com', genericInbox:null, personalInbox:null, mapsUrl:null});
const cases=[
 ['email + linkedin + ig + direct phone', {email:'pat@biz.com', linkedinUrl:'https://www.linkedin.com/in/patowner', phone:'205-555-0111'}, 'email'],
 ['linkedin + ig + direct phone',         {linkedinUrl:'https://www.linkedin.com/in/patowner', phone:'205-555-0111'}, 'linkedin'],
 ['direct phone only',                    {phone:'205-555-0111'}, 'phone'],
 ['nothing but the main line',            {}, 'mainline'],
];
let f=0;
for(const [label,over,want] of cases){
  const extra = label.includes('ig') ? {instagram:'patowner'} : {};
  const L=buildContactLadder(Object.assign(mk(over), extra),{rankOf:m.r,rootDomain:m.rd,category:'gym'});
  const row=L.tiers[0].rows[0];
  const ok=row.channel===want; if(!ok)f++;
  console.log(`  ${ok?'PASS':'FAIL'} ${label.padEnd(38)} -> ${row.channel}${row.reachVia?' ("'+row.reachVia+'")':''}`);
}
console.log('failures:',f);
