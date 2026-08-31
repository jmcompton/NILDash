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
const setSrc=src.match(/const _GENERIC_LOCALPARTS = new Set\(\[[\s\S]*?\n\]\);/)[0];
const vSrc=src.match(/function _validEmail\(email\) \{[\s\S]*?\n\}/)[0];
const gSrc=src.match(/function _isGenericInbox\(email\) \{[\s\S]*?\n\}/)[0];
const nSrc=src.match(/function _localPartMatchesName\(localPart, fullName\) \{[\s\S]*?\n\}/)[0];
const m={}; new Function('module', setSrc+'\n'+vSrc+'\n'+gSrc+'\n'+nSrc+'\nmodule.g=_isGenericInbox; module.n=_localPartMatchesName;')(m);
console.log('-- generic classification --');
for(const e of ['mccall@sohohomewood.bar','info@x.com','hello@x.com','events@x.com','mail@x.com','ask@x.com',
                'noreply@x.com','dhorn@x.com','taylor@x.com','orders@x.com','billing@x.com','schilleci@x.com'])
  console.log('  '+(m.g(e)?'GENERIC ':'person? ')+e);
console.log('\n-- mailbox -> person matching --');
const cases=[['mccall','Sarah McCall',true],['dhorn','Dave Horn',true],['dave','Dave Horn',true],
             ['horn','Dave Horn',true],['davehorn','Dave Horn',true],['hornd','Dave Horn',false],
             ['mccall','Dave Horn',false],['taylor','Taylor Hughes',true]];
let f=0;
for(const [lp,nm,want] of cases){ const got=m.n(lp,nm); if(got!==want)f++;
  console.log(`  ${got===want?'PASS':'FAIL'}  ${String(lp).padEnd(10)} vs ${String(nm).padEnd(16)} -> ${got}`); }
console.log('\nfailures:',f);
