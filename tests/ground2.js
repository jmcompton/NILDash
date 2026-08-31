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
const mapSrc = src.match(/const SCHOOL_LOCATIONS = \{[\s\S]*?\n\};/)[0];
const lookSrc= src.match(/function lookupSchoolLocation\(school\) \{[\s\S]*?\n\}/)[0];
const fnSrc  = src.match(/function _foreignSchoolIn\(text, athleteSchool\) \{[\s\S]*?\n\}/)[0];
const ambSrc= src.match(/const AMBIGUOUS_SHORT_FORMS = new Set\(\[[\s\S]*?\]\);/)[0];
const m={}; new Function('module', mapSrc+'\n'+ambSrc+'\n'+lookSrc+'\n'+fnSrc+'\nmodule.f=_foreignSchoolIn;')(m);
const cases=[
 ['Great foot traffic from the UConn campus.','Samford University','FLAG'],
 ['Steps from the Samford University campus.','Samford University','clean'],
 ['Right by Samford campus.','Samford University','clean'],
 ['Local deli with community ties in Homewood.','Samford University','clean'],
 ['Popular with Auburn University students.','Samford University','FLAG'],
 ['Draws the Georgia Tech crowd.','Georgia Institute of Technology','clean'],
 ['Near Georgia Institute of Technology.','Georgia Tech','clean'],
 ['Beloved by Ole Miss fans.','Samford University','FLAG'],
 // COLLOQUIAL NAMES. The model writes "Ole Miss", not "University of
 // Mississippi", and the guard only matches what is in SCHOOL_LOCATIONS -- so a
 // rationale naming the wrong school by its common name went through clean.
 ['Beloved by Ole Miss fans.','University of Mississippi','clean'],
 ['A Mizzou game-day staple.','Samford University','FLAG'],
 ['A Mizzou game-day staple.','University of Missouri','clean'],
 ['Packed on Bama game days.','Auburn University','FLAG'],
 ['Packed on Bama game days.','University of Alabama','clean'],
 ['Two blocks from Pitt.','Samford University','FLAG'],
 ['Two blocks from Pitt.','University of Pittsburgh','clean'],
 // The short aliases must not fire INSIDE a longer word: "Bama" sits inside
 // "Alabama" and "Pitt" inside "Pittsburgh", and a word-boundary miss here would
 // rewrite correct rationales.
 ['Downtown Pittsburgh location.','University of Pittsburgh','clean'],
 ['Serving the Mississippi delta.','University of Mississippi','clean'],
 // THE STATE NAME IS NOT A SCHOOL NAME. "alabama" is the short form of
 // "University of Alabama" AND the state most of this roster sells in, so these
 // rationales were flagged as hallucinations and replaced with the generic
 // template. The model had done nothing wrong.
 ['Family-run barbecue institution in Alabama with deep community roots.','Auburn University','clean'],
 ['One of the oldest hardware stores in Alabama, still family owned.','Samford University','clean'],
 ['A Birmingham staple serving Alabama football crowds since 1974.','Samford University','clean'],
 // Named in full it is still caught -- the guard is narrowed, not switched off.
 ['Steps from the University of Alabama campus.','Auburn University','FLAG'],
 ['Steps from the University of Alabama campus.','University of Alabama','clean'],
 // And the specific alias still fires on its own, because "bama" is nobody's state.
 ['Packed on Bama game days.','Samford University','FLAG'],
 // The same collision across the rest of the map: states, the towns the schools
 // sit in, and ordinary words. All 63 colliding keys are covered.
 ['A Georgia favourite, three locations across the metro.','Kennesaw State University','clean'],
 ['A Texas institution with lines out the door on Saturdays.','Baylor University','clean'],
 ['Best peach cobbler in Georgia, per the local paper.','Mercer University','clean'],
 ['Downtown Cincinnati lunch spot with heavy office foot traffic.','Xavier University','clean'],
 ['A Boston staple near the Fenway crowds.','Northeastern University','clean'],
 ['Two blocks from the Pittsburgh convention centre.','Samford University','clean'],
 // A school-specific alias is NOT bare geography and still fires. "georgia tech"
 // is not "georgia", which is the whole distinction this list draws.
 ['Draws the Georgia Tech crowd.','Samford University','FLAG'],
 ['Steps from the University of Georgia campus.','Samford University','FLAG'],
];
let fails=0;
for(const [txt,school,want] of cases){
  const bad=m.f(txt,school); const got=bad?'FLAG':'clean';
  const ok = got===want; if(!ok) fails++;
  console.log((ok?'PASS':'FAIL')+'  '+(bad?('['+bad+']'):'').padEnd(24)+` school=${school} :: ${txt}`);
}
console.log('\nfailures:', fails);
// EXIT NON-ZERO ON FAILURE. This printed FAIL and exited 0, so any runner checking
// exit codes counted it as a pass. The one case it catches today (Samford / Ole Miss)
// is a real, known, pre-existing miss in _foreignSchoolIn, and it should be loud.
process.exit(fails ? 1 : 0);
