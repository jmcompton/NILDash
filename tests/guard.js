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
// The final sport guard. Missouri's baseball coach must never be Missouri's football
// head coach, and no real football staffer may be lost to a false positive.
const path = require('path');
const AI = path.resolve(REPO + 'server/ai.js');
require.cache[AI] = { id: AI, filename: AI, loaded: true, exports: { oneShot: async () => '', MODEL_FAST: 'x' } };
const pm = require(REPO + 'server/services/programMap.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

console.log('-- email names another sport --');
ok('baseball@missouri.edu', pm.emailNamesOtherSport('baseball@missouri.edu') === 'baseball',
  pm.emailNamesOtherSport('baseball@missouri.edu'));
// The key is mens_basketball, not basketball: 'basketball' is only an input alias.
ok('mbb@school.edu maps to mens_basketball', pm.emailNamesOtherSport('mbb@school.edu') === 'mens_basketball',
  pm.emailNamesOtherSport('mbb@school.edu'));
ok('golf@school.edu', pm.emailNamesOtherSport('golf@school.edu') === 'golf', null);
ok('an address under a sport subdomain', pm.emailNamesOtherSport('info@baseball.missouri.edu') === 'baseball',
  pm.emailNamesOtherSport('info@baseball.missouri.edu'));

console.log('-- and the false positives that would make this dangerous --');
ok('patrick@ does not match track', pm.emailNamesOtherSport('patrick@missouri.edu') === null,
  pm.emailNamesOtherSport('patrick@missouri.edu'));
ok('jbaseball is not a token', pm.emailNamesOtherSport('jbaseballx@missouri.edu') === null,
  pm.emailNamesOtherSport('jbaseballx@missouri.edu'));
ok('golfer as part of a name is not golf', pm.emailNamesOtherSport('agolferty@x.edu') === null,
  pm.emailNamesOtherSport('agolferty@x.edu'));
ok('a normal staff address is fine', pm.emailNamesOtherSport('chrispr@gators.ufl.edu') === null,
  pm.emailNamesOtherSport('chrispr@gators.ufl.edu'));
ok('an ordinary surname address is fine', pm.emailNamesOtherSport('ellsworth@olemiss.edu') === null, null);
ok('football@ is never a contradiction', pm.emailNamesOtherSport('football@missouri.edu') === null, null);
ok('footballops@ is never a contradiction', pm.emailNamesOtherSport('footballops@x.edu') === null, null);
ok('empty email is not a contradiction', pm.emailNamesOtherSport(null) === null, null);

console.log('-- section or title text --');
ok('BASEBALL section', pm.textNamesOtherSport('BASEBALL') === 'baseball', null);
ok("BASKETBALL, MEN'S section", pm.textNamesOtherSport("BASKETBALL, MEN'S") === 'mens_basketball', null);
ok('Swimming and Diving', pm.textNamesOtherSport('Swimming and Diving') === 'swimming', null);
ok('CREATIVE is not a sport', pm.textNamesOtherSport('CREATIVE') === null, null);
ok('FOOTBALL is not a contradiction', pm.textNamesOtherSport('FOOTBALL') === null, null);
ok('Football Support Staff is not a contradiction',
  pm.textNamesOtherSport('Football Support Staff') === null, null);
ok('a mixed section naming football is allowed',
  pm.textNamesOtherSport('Football / Basketball Operations') === null,
  pm.textNamesOtherSport('Football / Basketball Operations'));
ok('a football title beats a non-football section',
  pm.sportContradiction({ title: 'Director of Football Operations', section: 'CREATIVE' }) === null, null);

console.log('-- the Missouri records, end to end --');
const missouri = [
  { name: 'Kerrick Jackson', title: 'Head Coach', email: 'baseball@missouri.edu', section: 'BASEBALL' },
  { name: 'Fixture Aldridge', title: 'Director of Player Personnel', email: 'a@missouri.edu', section: "BASKETBALL, MEN'S" },
  { name: 'Fixture Bramwell', title: 'Director of Recruiting', email: 'b@missouri.edu', section: "BASKETBALL, MEN'S" },
  { name: 'Fixture Castellan', title: 'General Manager', email: 'c@missouri.edu', section: 'CREATIVE' },
  { name: 'Fixture Danforth', title: 'Equipment Manager', email: 'd@missouri.edu', section: 'EQUIPMENT OPERATIONS' },
];
const mo = pm.recordsFromStaffPage('Missouri', missouri, 'https://mutigers.com/staff-directory');
ok('the baseball coach is DROPPED entirely, not demoted',
  !mo.some((r) => r.name === 'Kerrick Jackson'), mo.map((r) => r.name));
ok('no head coach is selected', !mo.some((r) => r.role === 'head_coach'), mo.filter((r) => r.role === 'head_coach'));
ok('the basketball personnel person is kept but untagged',
  mo.find((r) => r.name === 'Fixture Aldridge').role === 'staff',
  mo.find((r) => r.name === 'Fixture Aldridge').role);
ok('no player_personnel key contact', !mo.some((r) => r.role === 'player_personnel'), null);
ok('no recruiting key contact', !mo.some((r) => r.role === 'recruiting'), null);
ok('NO key contacts at all: empty beats wrong',
  mo.filter((r) => r.is_key_contact).length === 0, mo.filter((r) => r.is_key_contact));
ok('the roster is still stored', mo.length === 4, mo.length);
ok('the CREATIVE GM is blocked too',
  mo.find((r) => r.name === 'Fixture Castellan').role === 'staff',
  mo.find((r) => r.name === 'Fixture Castellan').role);

console.log('-- the page-level rule must NOT over-block functional sections --');
// Sections that describe function rather than sport. No other sport is named, so the
// multi-sport rule must not fire and these key contacts must survive.
const functional = [
  { name: 'Fixture Marchetti', title: 'Head Coach', email: 'm@school.edu', section: 'Coaching Staff' },
  { name: 'Fixture Northrup', title: 'General Manager', email: 'n@school.edu', section: 'Support Staff' },
  { name: 'Fixture Ostrander', title: 'Director of Recruiting', email: 'o@school.edu', section: 'Support Staff' },
];
const fn = pm.recordsFromStaffPage('Elsewhere', functional, 'https://x.com/staff');
ok('functional sections do not trip the multi-sport rule',
  fn.filter((r) => r.is_key_contact).length === 3, fn.filter((r) => r.is_key_contact).map((r) => r.name));

console.log('-- a football title survives a multi-sport page --');
const mixedPage = [
  { name: 'Fixture Papa', title: 'Director of Football Operations', email: 'p@school.edu', section: 'OPERATIONS' },
  { name: 'Fixture Quebec', title: 'Director of Operations', email: 'q@school.edu', section: 'BASEBALL' },
  { name: 'Fixture Romeo', title: 'Equipment Manager', email: 'r@school.edu', section: 'GOLF' },
];
const mx = pm.recordsFromStaffPage('Elsewhere', mixedPage, 'https://x.com/staff');
ok('the row naming football keeps its role',
  mx.some((r) => r.name === 'Fixture Papa' && r.role === 'general_manager' && r.is_key_contact),
  mx.map((r) => [r.name, r.role]));
ok('the baseball row does not', mx.find((r) => r.name === 'Fixture Quebec').role === 'staff',
  mx.find((r) => r.name === 'Fixture Quebec').role);

console.log('-- a filtered football page is never affected by the page rule --');
const filtered = [
  { name: 'Fixture Sierra', title: 'Head Coach', email: 's@school.edu', section: 'Football' },
  { name: 'Fixture Tango', title: 'General Manager', email: 't@school.edu', section: 'Football Support Staff' },
  { name: 'Fixture Uniform', title: 'Director of Recruiting', email: 'u@school.edu', section: 'Football Support Staff' },
];
const fd = pm.recordsFromStaffPage('Auburn', filtered, 'https://x.com/staff');
ok('all three key contacts survive', fd.filter((r) => r.is_key_contact).length === 3,
  fd.filter((r) => r.is_key_contact).map((r) => r.name));

console.log('-- a real football school is untouched by the guard --');
const lsu = [
  { name: 'Fixture Ellsworth', title: 'Head Football Coach', email: 'ellsworth@lsu.edu', section: 'Football' },
  { name: 'Fixture Farrow', title: 'General Manager', email: 'farrow@lsu.edu', section: 'Football' },
  { name: 'Fixture Gathright', title: 'Director of Player Personnel', email: 'gathright@lsu.edu', section: 'Football' },
  { name: 'Fixture Hollingsworth', title: 'Director of Recruiting', email: 'holl@lsu.edu', section: 'Football' },
];
const l = pm.recordsFromStaffPage('LSU', lsu, 'https://lsusports.net/sports/football/coaches');
ok('all four key contacts survive', l.filter((r) => r.is_key_contact).length === 4,
  l.filter((r) => r.is_key_contact).map((r) => [r.role, r.name]));
ok('all four keep their emails', l.filter((r) => r.is_key_contact).every((r) => r.email), null);

console.log('-- a page with no section at all is still guarded by email --');
const noSection = [
  { name: 'Fixture Ingerson', title: 'Head Coach', email: 'mbb@school.edu', section: null },
  { name: 'Fixture Jessup', title: 'General Manager', email: 'jessup@school.edu', section: null },
];
const ns = pm.recordsFromStaffPage('Somewhere', noSection, 'https://x.com/staff');
ok('the basketball address is dropped even with no section',
  !ns.some((r) => r.name === 'Fixture Ingerson'), ns.map((r) => r.name));
ok('the clean record survives', ns.some((r) => r.name === 'Fixture Jessup' && r.is_key_contact), ns);

console.log('-- an untagged staff member with a sport email is still dropped --');
const rosterOnly = [
  { name: 'Fixture Kentwood', title: 'Athletic Trainer', email: 'softball@school.edu', section: 'SOFTBALL' },
  { name: 'Fixture Ledbetter', title: 'Head Coach', email: 'led@school.edu', section: 'Football' },
];
const ro = pm.recordsFromStaffPage('Somewhere', rosterOnly, 'https://x.com/staff');
ok('dropped from the roster too, the address is the contradiction',
  !ro.some((r) => r.name === 'Fixture Kentwood'), ro.map((r) => r.name));
ok('the football head coach is unaffected',
  ro.some((r) => r.role === 'head_coach' && r.is_key_contact), ro);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
