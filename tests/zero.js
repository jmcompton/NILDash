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
// The last 9 schools: new candidate paths, the football-scoped-URL exemption,
// the row-markup diagnostic, and the targeted refetch flags.
const fs = require('fs');
const path = require('path');
const AI = path.resolve(REPO + 'server/ai.js');
require.cache[AI] = { id: AI, filename: AI, loaded: true, exports: {
  oneShot: async () => '', MODEL_FAST: 'x', webSearchJson: async () => ({ text: '{}' }),
  withTimeout: (p) => p,
} };
const pm = require(REPO + 'server/services/programMap.js');
const sp = require(REPO + 'server/services/staffPage.js');
const JOB = fs.readFileSync(REPO + 'server/jobs/programMapPilot.js', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

console.log('-- 1. the new candidate paths --');
const C = pm.STAFF_URL_CANDIDATES;
for (const p of ['/sports/football/coaches/2026', '/sports/football/coaches/1000',
  '/staff-directory/?path=football', '/coaches', '/football/coaches']) {
  ok(`includes ${p}`, C.includes(p), null);
}
ok('13 candidates now', C.length === 13, C.length);
ok('the original 8 are all still there',
  ['/sports/football/coaches', '/sports/football/coaches/', '/sports/football/staff',
   '/staff-directory/department/football', '/staff-directory?path=football',
   '/staff-directory/football', '/coaches.aspx?path=football', '/sports/football/roster/staff']
    .every((p) => C.includes(p)), null);
ok('no duplicates', new Set(C).size === C.length, null);
// The bare paths are the most likely to hit a department page, so they must be last:
// an earlier accept would win before a football-specific path is ever tried.
ok('the bare /coaches paths are tried LAST',
  C.indexOf('/coaches') > C.indexOf('/sports/football/coaches')
  && C.indexOf('/football/coaches') > C.indexOf('/staff-directory/department/football'),
  { coaches: C.indexOf('/coaches'), footballCoaches: C.indexOf('/football/coaches') });

console.log('-- 2a. a football-scoped URL rescues an unlabeled department page --');
// A page whose sections name other sports and never name football, served from a
// football URL. Every row should keep its role.
const unlabeled = [
  { name: 'Matt Fixture', title: 'General Manager', section: 'Administration' },
  { name: 'Fixture Bramwell', title: 'Director of Player Personnel', section: 'Administration' },
  { name: 'Fixture Castellan', title: 'Director of Recruiting', section: 'Administration' },
  { name: 'Fixture Danforth', title: 'Head Coach', section: 'BASEBALL' },
];
const viaFootballUrl = pm.recordsFromStaffPage('Virginia', unlabeled,
  'https://virginiasports.com/sports/football/coaches');
const keys = viaFootballUrl.filter((r) => r.is_key_contact);
ok('the GM keeps his role when the URL names football',
  keys.some((r) => r.role === 'general_manager' && r.name === 'Matt Fixture'),
  keys.map((r) => [r.role, r.name]));
ok('personnel and recruiting keep theirs too',
  keys.some((r) => r.role === 'player_personnel') && keys.some((r) => r.role === 'recruiting'),
  keys.map((r) => r.role));
ok('BUT the baseball head coach is STILL blocked, the guard is not relaxed',
  !viaFootballUrl.some((r) => r.role === 'head_coach'),
  viaFootballUrl.filter((r) => r.role === 'head_coach'));

console.log('-- 2a. the same page on a NON-football URL stays blocked --');
const viaDeptUrl = pm.recordsFromStaffPage('Missouri', unlabeled,
  'https://mutigers.com/staff-directory');
ok('no key contacts from a department URL',
  viaDeptUrl.filter((r) => r.is_key_contact).length === 0,
  viaDeptUrl.filter((r) => r.is_key_contact));
ok('Missouri is unaffected by the change, as intended',
  !viaDeptUrl.some((r) => r.role === 'general_manager'), null);

console.log('-- 2a. a football-named TITLE was already exempt, and still is --');
const titled = pm.recordsFromStaffPage('Somewhere', [
  { name: 'Fixture Ellsworth', title: 'General Manager, Football', section: 'Administration' },
  { name: 'Fixture Farrow', title: 'Director of Football Operations', section: 'Administration' },
  { name: 'Fixture Gathright', title: 'Director of Recruiting', section: 'Administration' },
  { name: 'Fixture Hollingsworth', title: 'Head Coach', section: 'BASKETBALL' },
], 'https://x.com/staff-directory');
ok('a title naming football keeps its role on a department URL',
  titled.some((r) => r.role === 'general_manager' && r.name === 'Fixture Ellsworth'),
  titled.filter((r) => r.role === 'general_manager'));
ok('a title with no sport does not', !titled.some((r) => r.name === 'Fixture Gathright' && r.role === 'recruiting'), null);
ok('the basketball coach is still blocked',
  !titled.some((r) => r.role === 'head_coach'), null);

console.log('-- 2a. a genuine football page is untouched --');
const normal = pm.recordsFromStaffPage('LSU', [
  { name: 'Fixture India', title: 'Head Football Coach', section: 'Football' },
  { name: 'Fixture Juliett', title: 'General Manager', section: 'Football' },
  { name: 'Fixture Kilo', title: 'Director of Recruiting', section: 'Football' },
], 'https://lsusports.net/sports/football/coaches');
ok('all three key contacts survive', normal.filter((r) => r.is_key_contact).length === 3,
  normal.filter((r) => r.is_key_contact).map((r) => r.role));

console.log('-- 2b. the row-markup diagnostic --');
// A page whose title sits in a second cell: the parser SHOULD find it.
const withTitles = `<html><body><table>
<tr><td>Fixture Lima</td><td>Head Football Coach</td><td><a href="mailto:l@x.edu">l@x.edu</a></td></tr>
<tr><td>Fixture Mike</td><td>General Manager</td><td></td></tr>
</table></body></html>`;
const good = sp.inspectRows(withTitles, 'https://x.com/s/', 3);
ok('reports how many blocks exist', good.blocks === 2, good.blocks);
ok('shows the cells it found', good.samples[0].cells.includes('Head Football Coach'), good.samples[0].cells);
ok('shows what the parser extracted',
  good.samples[0].parsedName === 'Fixture Lima' && good.samples[0].parsedTitle === 'Head Football Coach',
  [good.samples[0].parsedName, good.samples[0].parsedTitle]);

// The Maryland shape: a name and nothing else in the row.
const noTitles = `<html><body><table>
<tr><td><a href="/staff/lima">Fixture Lima</a></td></tr>
<tr><td><a href="/staff/mike">Fixture Mike</a></td></tr>
</table></body></html>`;
const bare = sp.inspectRows(noTitles, 'https://x.com/s/', 3);
ok('a title-less row parses a name', bare.samples[0].parsedName === 'Fixture Lima', bare.samples[0]);
ok('and reports title null, which is the finding', bare.samples[0].parsedTitle === null, bare.samples[0]);
ok('one cell only, which says the page has no title column',
  bare.samples[0].cellCount === 1, bare.samples[0].cellCount);

// The other possibility: the title hides in an attribute.
const attrTitle = `<html><body><table>
<tr><td><a href="/s/1" title="Head Football Coach">Fixture Lima</a></td></tr>
</table></body></html>`;
const attr = sp.inspectRows(attrTitle, 'https://x.com/s/', 3);
ok('an attribute title is surfaced so the cause is visible',
  attr.samples[0].attrs.some((a) => /Head Football Coach/.test(a)), attr.samples[0].attrs);
ok('even though the parser did not use it', attr.samples[0].parsedTitle === null, attr.samples[0].parsedTitle);
ok('raw markup is included for reading', /<td>/.test(attr.samples[0].rawHtml), attr.samples[0].rawHtml.slice(0, 60));

console.log('-- 3. targeted refetch flags --');
ok('--school can be repeated', /a === '--school' && args\[i \+ 1\]/.test(JOB), null);
ok('named schools override the full list', /targets = onlySchools;/.test(JOB), null);
ok('--only-zero exists', /args\.includes\('--only-zero'\)/.test(JOB), null);
ok('it selects schools with no key contacts',
  /!by\[s\] \|\| by\[s\] === 0/.test(JOB), null);
ok('it lists them before fetching', /for \(const s of targets\) console\.log\(`    \$\{s\}`\)/.test(JOB), null);
ok('it exits cleanly when nothing is broken', /Nothing to repair/.test(JOB), null);
ok('--resume is ignored for an explicit repair list, and says so',
  /--resume ignored/.test(JOB), null);
ok('the coverage block measures the FULL known list after a targeted run',
  /const all = programMap\.ALL_SCHOOLS;/.test(JOB), null);
ok('--rows is wired into --inspect', /args\.includes\('--rows'\)/.test(JOB), null);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
