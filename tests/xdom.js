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
const m={}; new Function('module', rankSrc+'\n'+rootSrc+'\nmodule.r=_contactAuthorityRank; module.rd=_rootDomain;')(m);
const { buildContactLadder, crossDomainNote } = require(REPO + 'server/services/contactLadder.js');
console.log('-- crossDomainNote unit --');
const cases=[['info@eskridgeandwhite.com','https://ewmotiontherapy.com','FLAG'],
             ['info@ewmotiontherapy.com','https://ewmotiontherapy.com','clean'],
             ['dave@www.ewmotiontherapy.com','https://ewmotiontherapy.com','clean'],
             ['x@mail.ewmotiontherapy.com','https://ewmotiontherapy.com','clean'],
             ['x@gmail.com','https://ewmotiontherapy.com','FLAG'],
             ['x@anything.com',null,'clean']];
let f=0;
for(const [e,site,want] of cases){ const n=crossDomainNote(e,site,m.rd); const got=n?'FLAG':'clean';
  if(got!==want)f++; console.log(`  ${got===want?'PASS':'FAIL'} ${String(e).padEnd(32)} -> ${n||'(no note)'}`);}
console.log('failures:',f);

console.log('\n-- EW Motion Therapy ladder --');
const L=buildContactLadder({
  contacts:[{name:'Josh Eskridge',title:'Owner',email:'josh@eskridgeandwhite.com',phone:null,source:'facebook',sourceUrl:'https://facebook.com/x',confidence:'high'}],
  genericInbox:'info@eskridgeandwhite.com', personalInbox:null, businessPhone:'(205) 271-1250',
  website:'https://ewmotiontherapy.com', instagram:null, mapsUrl:null,
},{rankOf:m.r, rootDomain:m.rd, category:'wellness'});
console.log('mainLine:', L.mainLine.note);
for(const t of L.tiers) for(const r of t.rows)
  console.log(`  T${t.tier} ${String(r.name||r.title).padEnd(16)} email=${r.email||'-'}\n        note=${r.emailDomainNote||'(none)'}`);
