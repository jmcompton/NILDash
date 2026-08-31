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
// The seven polluted schools. Two holes let a department dump the SWEEP had already
// rejected become records anyway, because the sweep only decides what URL to store
// and --fetch-all reads that URL directly.
//
//   1. the URL-scoped exemption excused a dump outright
//   2. the page-level rule required a heading naming a RIVAL sport, so a FLAT dump
//      with no headings at all was never even examined
//
// Both are exercised against the shipped recordsFromStaffPage.
const aiPath = require.resolve(REPO + 'server/ai.js');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  runSourceWaves: async () => ({ results: [] }), webSearchJson: async () => ({ text: '' }),
  withTimeout: (p) => p, withDeadline: (p) => p, oneShot: async () => '', MODEL_FAST: 'fast' } };
const pm = require(REPO + 'server/services/programMap.js');
const fs = require('fs');

let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

const SUR = ['Alvarez', 'Bramwell', 'Castellan', 'Delacroix', 'Everly', 'Fairholm', 'Grimaldi',
  'Hollandsworth', 'Ingerson', 'Jorgensen', 'Kilbride', 'Lindqvist', 'Marchetti', 'Norrington',
  'Okonkwo', 'Pemberton', 'Quintanilla', 'Rasmussen', 'Stavros', 'Thackeray', 'Uxbridge',
  'Vandermeer', 'Wetherby', 'Xanthopoulos', 'Yardley', 'Zabriskie'];
const GIV = ['Fixture', 'Sample', 'Placeholder', 'Specimen', 'Exemplar'];
const nm = (i) => `${GIV[i % 5]} ${SUR[i % 26]}${SUR[Math.floor(i / 26) % 26]}`;

// A department dump: every sport's staff, lots of head coaches, no per-sport headings.
// This is the Virginia shape, and the reason 25 head coaches conflicted.
function flatDump(n, section) {
  const titles = ['Head Coach', 'Assistant Coach', 'Director of Operations',
    'Head Coach', 'Associate Head Coach', 'Director of Player Personnel',
    'Athletic Director', 'Senior Associate AD', 'Academic Advisor', 'Athletic Trainer'];
  return Array.from({ length: n }, (_, i) => ({
    name: nm(i), title: titles[i % titles.length], section: section || null, email: null,
  }));
}

// A real men's basketball staff page: small, no headings needed.
function realStaff(n) {
  const titles = ['Head Coach', 'Associate Head Coach', 'Assistant Coach', 'Assistant Coach',
    'Director of Basketball Operations', 'Director of Player Personnel', 'Video Coordinator',
    'Strength and Conditioning Coach', 'Athletic Trainer'];
  return Array.from({ length: n }, (_, i) => ({
    name: nm(i + 300), title: titles[i % titles.length], section: null, email: null,
  }));
}

const BB_URL = 'https://gamecocksonline.com/sports/mens-basketball/coaches';
const DEPT_URL = 'https://gamecocksonline.com/staff-directory';

console.log('-- HOLE 1: the URL exemption excused a dump --');
// The URL names the sport, so the old rule logged "roles are allowed" and tagged
// every matching title on a 393-row department directory.
const urlScoped = pm.recordsFromStaffPage('South Carolina', flatDump(393, 'ADMINISTRATION'), BB_URL, 'basketball');
ok('a 393-row page on a basketball URL yields ZERO records', urlScoped.length === 0, urlScoped.length);
ok('and therefore no head coach at all', !urlScoped.some((r) => r.role === 'head_coach'));

console.log('\n-- HOLE 2: a FLAT dump named no rival sport, so nothing examined it --');
// No sections whatsoever. pageNamesOtherSports was false, so multiSportNoSport was
// false, so every check was skipped regardless of the URL.
const flat = pm.recordsFromStaffPage('Virginia', flatDump(370, null), DEPT_URL, 'basketball');
ok('a 370-row flat page yields ZERO records', flat.length === 0, flat.length);
ok('no conflicting head coaches survive', flat.filter((r) => r.role === 'head_coach').length === 0,
  flat.filter((r) => r.role === 'head_coach').length);

console.log('\n-- what it must NOT break: a real staff still works --');
const real = pm.recordsFromStaffPage('Kentucky', realStaff(9), BB_URL, 'basketball');
ok('a 9-row basketball staff is kept', real.length === 9, real.length);
ok('with a head coach', real.some((r) => r.role === 'head_coach' && r.is_key_contact));
ok('and an ops director', real.some((r) => r.role === 'basketball_ops'));

console.log('\n-- and a big page that WAS cut to a sport section is still exempt --');
// 60 rows all sitting under a men's basketball heading. Over the ceiling, but the
// heading says they really are this sport's staff, so the count means what it says.
const cut = pm.recordsFromStaffPage('Kentucky', flatDump(60, "BASKETBALL, MEN'S"), DEPT_URL, 'basketball');
ok('a cut page over the ceiling is still accepted', cut.length > 0, cut.length);

console.log('\n-- the boundary is exactly the ceiling, not near it --');
ok('40 rows (at the ceiling) is kept', pm.recordsFromStaffPage('X', realStaff(40), BB_URL, 'basketball').length === 40);
ok('41 rows (over it) is refused', pm.recordsFromStaffPage('X', realStaff(41), BB_URL, 'basketball').length === 0);

console.log('\n-- FOOTBALL IS UNTOUCHED: no ceiling means no new refusal --');
const fbTitles = ['Head Football Coach', 'Offensive Coordinator', 'Director of Football Operations',
  'Director of Player Personnel', 'Director of Recruiting', 'General Manager'];
const fbBig = Array.from({ length: 373 }, (_, i) => ({ name: nm(i), title: fbTitles[i % fbTitles.length], section: null, email: null }));
const fb = pm.recordsFromStaffPage('Missouri', fbBig, 'https://mutigers.com/staff-directory', 'football');
ok('Missouri\'s 373-row football page still produces records', fb.length > 0, fb.length);
ok('football has no ceiling to trip', pm.maxStaffFor('football') === null);

console.log('\n-- zero records is what CLEARS a polluted school --');
// saveProgramStaff deletes by (school, sport) before inserting, so [] is not a no-op:
// it is the thing that removes the bad rows on the next fetch.
const STORE = fs.readFileSync(REPO + 'server/store.js', 'utf8');
const saveFn = STORE.slice(STORE.indexOf('async function saveProgramStaff('), STORE.indexOf('async function saveProgramStaffSnapshot'));
ok('the delete is unconditional, so an empty batch still clears',
  /DELETE FROM program_staff WHERE school = \$1 AND sport = \$2/.test(saveFn), null);
ok('the delete runs before the insert loop',
  saveFn.indexOf('DELETE FROM program_staff') < saveFn.indexOf('for (const r of'), null);
ok('and it is scoped to one sport, so football is not collateral',
  !/DELETE FROM program_staff WHERE school = \$1'/.test(saveFn), null);

console.log('\n-- the repair command --');
const JOB = fs.readFileSync(REPO + 'server/jobs/programMapPilot.js', 'utf8');
const repRaw = JOB.slice(JOB.indexOf("if (args.includes('--repair')"), JOB.indexOf("if (args.includes('--fetch-all'))"));
// Comments stripped before asserting on code, the same lesson as twice before: an
// explanatory comment sitting between two calls should not decide whether a regex
// matches, and a comment quoting old behaviour should not fail a check on new.
const rep = repRaw.replace(/^\s*\/\/.*$/gm, '');
ok('--clear-rejected is accepted as the same command', /--clear-rejected/.test(rep), null);
ok('DRY RUN unless --apply is typed', /const apply = args\.includes\('--apply'\)/.test(rep), null);
const applyGuards = [...rep.matchAll(/if \(apply\)/g)].length;
ok('every destructive step is behind that flag', applyGuards >= 2, applyGuards);
ok('no DELETE outside an apply branch',
  rep.split('if (apply)').slice(0, 1).join('').indexOf('DELETE FROM') === -1, null);
ok('it refuses to run without an explicit target',
  /if \(!targets\) \{[\s\S]{0,200}Usage: --repair/.test(rep), null);
ok('BEFORE counts are read from the database, not assumed',
  /SELECT COUNT\(\*\)::int AS n[\s\S]{0,140}FROM program_staff WHERE school = \$1 AND sport = \$2/.test(rep), null);
ok('it re-sweeps rather than trusting the stored URL', /sweepStaffUrl\(school, store, \{ sport \}\)/.test(rep), null);
ok('the sweep is bounded, so a repair cannot hang either', /ai\.withDeadline\([\s\S]{0,200}sweepStaffUrl/.test(rep), null);
ok('a HAND-SET url is never cleared', /oldUrl && !locked/.test(rep) && /url_locked/.test(rep), null);
ok('clearing nulls staff_url only, keeping the rest of the row',
  /SET staff_url = NULL/.test(rep) && !/DELETE FROM program_source/.test(rep), null);
ok('the cleared url is marked so its origin is readable later',
  /staff_url_discovered_via = 'repair-cleared'/.test(rep), null);
ok('a failed sweep leaves the school ALONE rather than deleting on no evidence',
  /sweep\s+FAILED[\s\S]{0,120}leaving this school untouched/.test(rep), null);
ok('a failed fetch does the same', /fetch\s+FAILED[\s\S]{0,120}rows left as they were/.test(rep), null);
ok('it states plainly that zero is the intended outcome', /ZERO \$\{SPORT\.label\} records/.test(repRaw), null);

console.log('\nfailures: ' + f);
process.exit(f ? 1 : 0);
