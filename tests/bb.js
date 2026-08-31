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
// Basketball end to end through the SHIPPED functions: the section filter, the
// record builder, and the sweep. The question every test here asks is the same one:
// can a women's basketball row reach a men's basketball result, or a football row
// reach a basketball one, by any route.
const aiPath = require.resolve(REPO + 'server/ai.js');
require.cache[aiPath] = { id: aiPath, filename: aiPath, loaded: true, exports: {
  runSourceWaves: async () => ({ results: [] }),
  webSearchJson: async () => ({ text: '' }),
  withTimeout: (p) => p, withDeadline: (p) => p,
  oneShot: async () => '',
  MODEL_FAST: 'fast',
} };
const staffPage = require(REPO + 'server/services/staffPage.js');
const pm = require(REPO + 'server/services/programMap.js');
const sports = require(REPO + 'server/services/sports.js');

let f = 0;
const ok = (n, c, got) => { if (!c) { f++; console.log(`  FAIL ${n}${got !== undefined ? '  got=' + JSON.stringify(got) : ''}`); } else console.log('  PASS ' + n); };

// A department-wide directory with three sports on it, the shape that made Missouri
// return a baseball coach as the football head coach.
function deptPage() {
  const rows = [
    { name: 'Fixture Alvarez', title: 'Head Coach', section: 'FOOTBALL', email: null },
    { name: 'Fixture Bramwell', title: 'Director of Football Operations', section: 'FOOTBALL', email: null },
    { name: 'Fixture Castellan', title: 'General Manager', section: 'FOOTBALL', email: null },
    { name: 'Fixture Delacroix', title: 'Head Coach', section: "BASKETBALL, MEN'S", email: null },
    { name: 'Fixture Everly', title: 'Assistant Coach', section: "BASKETBALL, MEN'S", email: null },
    { name: 'Fixture Fairholm', title: 'Director of Basketball Operations', section: "BASKETBALL, MEN'S", email: null },
    { name: 'Fixture Grimaldi', title: 'Head Coach', section: "BASKETBALL, WOMEN'S", email: null },
    { name: 'Fixture Hollandsworth', title: 'Assistant Coach', section: "BASKETBALL, WOMEN'S", email: null },
    { name: 'Fixture Ingerson', title: 'Director of Basketball Operations', section: "BASKETBALL, WOMEN'S", email: null },
  ];
  rows._sections = ['FOOTBALL', "BASKETBALL, MEN'S", "BASKETBALL, WOMEN'S"];
  return rows;
}

console.log('-- the section filter separates three sports on ONE page --');
const fb = staffPage.filterToSportSections(deptPage(), 'football');
ok('football keeps only its own 3', fb.filtered && fb.staff.length === 3, fb.staff.map((p) => p.name));
const mbb = staffPage.filterToSportSections(deptPage(), 'mens_basketball');
ok("men's keeps only its own 3", mbb.filtered && mbb.staff.length === 3, mbb.staff.map((p) => p.name));
ok("men's never picks up a women's row",
  !mbb.staff.some((p) => sports.namesSport(p.section, 'womens_basketball')), mbb.staff.map((p) => p.section));
const wbb = staffPage.filterToSportSections(deptPage(), 'womens_basketball');
ok("women's keeps only its own 3", wbb.filtered && wbb.staff.length === 3, wbb.staff.map((p) => p.name));
// NOT a /MEN'S/ substring test: "WOMEN'S" contains "MEN'S", so that would fail on
// correct output. Ask the table which sport the heading actually names.
ok("women's never picks up a men's row",
  !wbb.staff.some((p) => sports.namesSport(p.section, 'mens_basketball')), wbb.staff.map((p) => p.section));
ok('the three results are disjoint',
  new Set([...fb.staff, ...mbb.staff, ...wbb.staff].map((p) => p.name)).size === 9);

console.log('\n-- a football-only page grouped by POSITION is not treated as department-wide --');
// This is the regression the narrow sectionMatch exists to prevent: football's `match`
// contains "offensive line", so matching headings with it would make this page look
// department-wide and cut it down to two groups, losing the support staff.
const posPage = (() => {
  const rows = [
    { name: 'Fixture Jorgensen', title: 'Offensive Line Coach', section: 'Offensive Line' },
    { name: 'Fixture Kilbride', title: 'Assistant Offensive Line Coach', section: 'Offensive Line' },
    { name: 'Fixture Lindqvist', title: 'Defensive Line Coach', section: 'Defensive Line' },
    { name: 'Fixture Marchetti', title: 'Head Strength Coach', section: 'Support Staff' },
    { name: 'Fixture Norrington', title: 'Director of Football Operations', section: 'Support Staff' },
  ];
  rows._sections = ['Offensive Line', 'Defensive Line', 'Support Staff'];
  return rows;
})();
const pos = staffPage.filterToSportSections(posPage, 'football');
ok('not filtered, so nobody is lost', !pos.filtered && pos.staff.length === 5, pos.staff.length);

console.log('\n-- but a person\'s own TITLE still rescues them from a generic heading --');
const genericPage = (() => {
  const rows = [
    { name: 'Fixture Okonkwo', title: 'Offensive Line Coach', section: 'Coaching Staff' },
    { name: 'Fixture Pemberton', title: 'Head Coach', section: 'FOOTBALL' },
    { name: 'Fixture Quintanilla', title: 'Director of Football Operations', section: 'FOOTBALL' },
    { name: 'Fixture Rasmussen', title: 'General Manager', section: 'FOOTBALL' },
    { name: 'Fixture Stavros', title: 'Head Coach', section: 'BASEBALL' },
  ];
  rows._sections = ['Coaching Staff', 'FOOTBALL', 'BASEBALL'];
  return rows;
})();
const gen = staffPage.filterToSportSections(genericPage, 'football');
ok('the OL coach under "Coaching Staff" is kept on his title',
  gen.filtered && gen.staff.some((p) => p.name === 'Fixture Okonkwo'), gen.staff.map((p) => p.name));
ok('the baseball head coach is not', !gen.staff.some((p) => p.name === 'Fixture Stavros'));

console.log('\n-- recordsFromStaffPage tags basketball roles, not football ones --');
const bbRecs = pm.recordsFromStaffPage('Kentucky', mbb.staff, 'https://ukathletics.com/sports/mens-basketball/coaches', 'mens_basketball');
ok('every record carries sport=mens_basketball', bbRecs.every((r) => r.sport === 'mens_basketball'));
const bbRoles = bbRecs.filter((r) => r.role !== 'staff').map((r) => r.role).sort();
ok('head_coach tagged', bbRoles.includes('head_coach'), bbRoles);
ok('basketball_ops tagged, which football does not have', bbRoles.includes('basketball_ops'), bbRoles);
ok('assistant_coach tagged, which football does not have', bbRoles.includes('assistant_coach'), bbRoles);
ok('no collective_director role exists on a basketball scan',
  !bbRecs.some((r) => r.role === 'collective_director'));

console.log('\n-- the same rows scanned as FOOTBALL tag nothing basketball-shaped --');
const asFb = pm.recordsFromStaffPage('Kentucky', mbb.staff, 'https://ukathletics.com/staff-directory', 'football');
ok('a basketball section cannot hold a football role',
  asFb.every((r) => r.role === 'staff'), asFb.map((r) => r.role));

console.log('\n-- the email guard drops a women\'s address on a men\'s scan --');
const withEmails = [
  { name: 'Fixture Thackeray', title: 'Head Coach', section: null, email: 'wbb@school.edu' },
  { name: 'Fixture Uxbridge', title: 'Assistant Coach', section: null, email: 'mbb@school.edu' },
  { name: 'Fixture Vandermeer', title: 'General Manager', section: null, email: 'football@school.edu' },
];
const em = pm.recordsFromStaffPage('School', withEmails, 'https://x.com/sports/mens-basketball/coaches', 'mens_basketball');
ok('wbb@ is DROPPED outright', !em.some((r) => r.name === 'Fixture Thackeray'), em.map((r) => r.name));
ok('football@ is DROPPED outright', !em.some((r) => r.name === 'Fixture Vandermeer'), em.map((r) => r.name));
ok('mbb@ survives as a key contact',
  em.some((r) => r.name === 'Fixture Uxbridge' && r.role === 'assistant_coach'));

console.log('\n-- thresholds are the sport\'s own, not football\'s --');
const smallStaff = [
  { name: 'Fixture Wetherby', title: 'Head Coach' },
  { name: 'Fixture Xanthopoulos', title: 'Assistant Coach' },
  { name: 'Fixture Yardley', title: 'Assistant Coach' },
];
const bbScore = staffPage.scoreStaffPage(smallStaff, pm.keyRolePatternsFor('mens_basketball'), pm.minKeyRolesFor('mens_basketball'));
ok('a 3-person basketball page passes its own bar', bbScore.accepted, bbScore.reasons);
const fbScore = staffPage.scoreStaffPage(smallStaff, pm.keyRolePatternsFor('football'), pm.minKeyRolesFor('football'));
ok('the same 3 rows fail football\'s bar', !fbScore.accepted, fbScore.reasons);
ok('football minKeyRoles is still 3', pm.minKeyRolesFor('football') === 3);
ok('football minStaff is still 5', pm.minStaffFor('football') === 5);
ok('basketball minKeyRoles is 2', pm.minKeyRolesFor('mens_basketball') === 2);
ok('basketball minStaff is 3', pm.minStaffFor('mens_basketball') === 3);

console.log('\n-- the basketball path list is exactly what was asked for --');
const paths = pm.candidatePathsFor('mens_basketball');
ok('8 candidates', paths.length === 8, paths.length);
ok('no bare /coaches', !paths.includes('/coaches'), paths);
ok('no /basketball/coaches', !paths.includes('/basketball/coaches'), paths);
ok('every path names the sport', paths.every((p) => /mens-basketball|mbball/.test(p)), paths);
ok('football still has its 13', pm.candidatePathsFor('football').length === 13);
ok('football still has the bare /coaches it always had', pm.candidatePathsFor('football').includes('/coaches'));

console.log('\n-- the sweep rejects a candidate that REDIRECTS to the other sport --');
// /sports/mens-basketball/coaches redirecting to the women's page: a women's staff
// page has no section headings to filter on, so without a URL check it would parse
// cleanly, score well, and be persisted as the men's page.
(async () => {
  const real = staffPage.fetchStaffPage;
  const person = (n, t) => `<tr><td><a href="/x">${n}</a></td><td>${t}</td></tr>`;
  const page = '<table>'
    + person('Fixture Zabriskie', 'Head Coach')
    + person('Fixture Ashcombe', 'Assistant Coach')
    + person('Fixture Beaumont', 'Director of Basketball Operations')
    + person('Fixture Carrington', 'Assistant Coach')
    + '</table>';
  const persisted = [];
  const store = {
    getProgramSource: async () => null,
    saveProgramSourceUrl: async (school, url) => { persisted.push(url); return true; },
  };
  staffPage.fetchStaffPage = async (url) => {
    // Every men's path bounces to the women's page. Nothing else answers.
    if (/mens-basketball|mbball/.test(url)) {
      return { ok: true, html: page, status: 200, finalUrl: 'https://ukathletics.com/sports/womens-basketball/coaches', bytes: page.length, ms: 1 };
    }
    return { ok: false, reason: 'http_404', status: 404, ms: 1 };
  };
  const r = await pm.sweepStaffUrl('Kentucky', store, { sport: 'mens_basketball' });
  staffPage.fetchStaffPage = real;
  ok('nothing was accepted', r.url === null, r.url);
  ok('nothing was persisted', persisted.length === 0, persisted);
  ok('the rejection reason names the other sport',
    r.tried.some((t) => (t.reasons || []).some((x) => /womens_basketball/.test(x))),
    r.tried.map((t) => t.reasons));

  console.log('\n-- and the same sweep ACCEPTS when the URL stays on the sport --');
  const persisted2 = [];
  const store2 = {
    getProgramSource: async () => null,
    saveProgramSourceUrl: async (school, url) => { persisted2.push(url); return true; },
  };
  staffPage.fetchStaffPage = async (url) => {
    if (url === 'https://ukathletics.com/sports/mens-basketball/coaches') {
      return { ok: true, html: page, status: 200, finalUrl: url, bytes: page.length, ms: 1 };
    }
    return { ok: false, reason: 'http_404', status: 404, ms: 1 };
  };
  const r2 = await pm.sweepStaffUrl('Kentucky', store2, { sport: 'mens_basketball' });
  staffPage.fetchStaffPage = real;
  ok('the men\'s page is accepted', r2.url === 'https://ukathletics.com/sports/mens-basketball/coaches', r2.url);
  ok('4 staff, above the basketball floor of 3', r2.staffCount === 4, r2.staffCount);
  ok('persisted once', persisted2.length === 1, persisted2);

  console.log('\n-- a sport that is not scannable is refused as a scan target --');
  ok('--sport baseball is refused', pm.normalizeSport('baseball') === null);
  ok('--sport basketball resolves to mens_basketball', pm.normalizeSport('basketball') === 'mens_basketball');
  ok('baseball still BLOCKS on a football scan',
    sports.namesOtherSport('Director of Baseball Operations', 'football') === 'baseball');

  console.log('\nfailures: ' + f);
  process.exit(f ? 1 : 0);
})();
