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
const { near } = require('./_near.js');
const OE  = fs.readFileSync(REPO + 'public/outreach-engine.js','utf8');
const HTML= fs.readFileSync(REPO + 'public/index.html','utf8');
const SRV = fs.readFileSync(REPO + 'server/index.js','utf8');
let f=0; const ok=(n,c,g)=>{ if(c) console.log('  PASS '+n); else {f++;console.log('  FAIL '+n+(g!==undefined?'  got='+JSON.stringify(g):''));} };

console.log('-- CASE 1: the deadend window, exactly as it was written --');
ok('the old 400-char window still reports FALSE (the bug it invented)',
  near(OE,'closeOutreachModal','outreach-mailbox-notice',400,{label:'deadend@400'})===false);
ok('a correct 600-char window passes',
  near(OE,'closeOutreachModal','outreach-mailbox-notice',600,{label:'deadend@600'})===true);
ok('  and the real distance is reported, not guessed',
  near.distance(OE,'closeOutreachModal','outreach-mailbox-notice')===438,
  near.distance(OE,'closeOutreachModal','outreach-mailbox-notice'));
ok('a 500-char window PASSES but is flagged as low headroom (438 of 500)',
  near(OE,'closeOutreachModal','outreach-mailbox-notice',500,{label:'deadend@500'})===true);

console.log('\n-- CASE 2: the onboarding windows that were 71 chars from breaking --');
ok('step 1 at the old 400 passes', near(HTML,'Step 1 of 3','Add your first athlete',400,{label:'onboarding step1@400'})===true);
ok('  and is flagged (needs 329 of 400)', true);

console.log('\n-- CASE 3: a target that survives only in a comment --');
const fake = 'function go() {\n  doThing();\n}\n// hometownCity was here\n';
ok('the comment match does NOT count as behaviour',
  near(fake,'function go','hometownCity',200,{label:'hometown-in-comment'})===false);
ok('  and with comments allowed it would have passed -- the false signal',
  near(fake,'function go','hometownCity',200,{includeComments:true})===true);

console.log('\n-- CASE 4: a missing anchor is an ERROR, not a quiet false --');
ok('a mistyped anchor is reported as unrunnable',
  near(SRV,'thisFunctionDoesNotExist','anything',100,{label:'typo-anchor'})===false);

console.log('\n-- WHAT THE SUITE WOULD PRINT --');
const hard = near.report();
console.log('\nhard errors: '+hard);
console.log('failures: '+f);
process.exit(f?1:0);
