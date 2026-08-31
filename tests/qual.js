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
// Fixes 1-4: verified-URL restore, quality scoring, section filtering, junk rows.
// Junk strings below are the ones that actually appeared in the Alabama and Auburn
// dumps. Staff names are synthetic except where the user reported a real one.
const path = require('path');
const AI_PATH = path.resolve(REPO + 'server/ai.js');
require.cache[AI_PATH] = { id: AI_PATH, filename: AI_PATH, loaded: true, exports: {
  webSearchJson: async () => ({ text: '{}' }), oneShot: async () => '{"staff":[]}',
  MODEL_FAST: 'x',
} };

const sp = require(REPO + 'server/services/staffPage.js');
const pm = require(REPO + 'server/services/programMap.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}
const ROLE_PATS = pm.ROLES.map((r) => r.match);

// ── FIX 4: junk rows ────────────────────────────────────────────────────────
console.log('-- fix 4: "Full Bio for X" yields X --');
ok('strips the Full Bio label', sp.stripNameLabel('Full Bio for Greg Byrne') === 'Greg Byrne',
  sp.stripNameLabel('Full Bio for Greg Byrne'));
ok('strips the opens-in-new-window suffix',
  sp.stripNameLabel('Fixture Alpha (Opens in a new window)') === 'Fixture Alpha',
  sp.stripNameLabel('Fixture Alpha (Opens in a new window)'));
ok('strips an Email prefix', sp.stripNameLabel('Email Sample Bravo') === 'Sample Bravo',
  sp.stripNameLabel('Email Sample Bravo'));
ok('leaves a clean name alone', sp.stripNameLabel('Kalen DeBoer') === 'Kalen DeBoer',
  sp.stripNameLabel('Kalen DeBoer'));

console.log('-- fix 4: carousel controls are junk, not people --');
ok('All Rotators Playing is junk', sp.JUNK_TEXT.test('All Rotators Playing'), null);
ok('Full Bio is junk', sp.JUNK_TEXT.test('Full Bio for Someone'), null);
ok('a real name is not junk', sp.JUNK_TEXT.test('Courtney Morgan') === false, null);

const alabamaJunk = `<html><body><table>
<tr><td><a href="/x">Full Bio for Greg Byrne</a></td><td>Director of Athletics</td></tr>
<tr><td><a href="/y">All Rotators Playing</a></td></tr>
<tr><td>Previous</td></tr>
<tr><td><a href="/z">Full Bio for Fixture Charlie</a></td><td>Deputy Athletics Director</td></tr>
</table></body></html>`;
const aj = sp.parseStaffHtml(alabamaJunk, 'https://rolltide.com/x');
ok('label rows became real names', aj.map((p) => p.name).join('|') === 'Greg Byrne|Fixture Charlie',
  aj.map((p) => p.name));
ok('carousel and nav rows dropped', aj.length === 2, aj.length);

// ── FIX 3: section headers ──────────────────────────────────────────────────
console.log('-- fix 3: section header detection --');
ok('Football Support Staff is a section', sp.looksLikeSectionHeader('Football Support Staff'), null);
ok('Sports Medicine is a section', sp.looksLikeSectionHeader('Sports Medicine'), null);
ok('Business Office is a section', sp.looksLikeSectionHeader('Business Office'), null);
ok('a person name is not a section', sp.looksLikeSectionHeader('Andrew Warsaw') === false, null);

// Auburn's shape: a department-wide directory with football under its own headings.
const auburn = `<html><body><table>
<tr><th colspan="3">Football</th></tr>
<tr><td>Fixture Delta</td><td>Head Coach</td><td><a href="mailto:d@auburn.edu">d@auburn.edu</a></td></tr>
<tr><th colspan="3">Football Support Staff</th></tr>
<tr><td>Andrew Warsaw</td><td>General Manager</td></tr>
<tr><td>Alex Fagan</td><td>Director of Player Personnel and Scouting</td></tr>
<tr><td>Harding Harper III</td><td>Executive Director of Recruiting</td></tr>
<tr><td>Luke Haker</td><td>Director of Football Operations</td></tr>
<tr><th colspan="3">Sports Medicine</th></tr>
<tr><td>Sample Echo</td><td>Head Athletic Trainer</td></tr>
<tr><td>Sample Foxtrot</td><td>Associate Athletic Trainer</td></tr>
<tr><th colspan="3">Ticket Operations</th></tr>
<tr><td>Sample Golf</td><td>Director of Ticketing</td></tr>
<tr><th colspan="3">Swimming and Diving</th></tr>
<tr><td>Sample Hotel</td><td>Head Coach</td></tr>
</table></body></html>`;
const au = sp.parseStaffHtml(auburn, 'https://auburntigers.com/staff-directory/department/football');
ok('parsed everyone before filtering', au.length === 9, au.length);
const warsaw = au.find((p) => p.name === 'Andrew Warsaw');
ok('Warsaw tagged with his section', warsaw && warsaw.section === 'Football Support Staff',
  warsaw && warsaw.section);
const swim = au.find((p) => p.name === 'Sample Hotel');
ok('swim coach tagged with his section', swim && swim.section === 'Swimming and Diving',
  swim && swim.section);
ok('section headers are not stored as people',
  au.every((p) => p.name !== 'Sports Medicine' && p.name !== 'Business Office'),
  au.map((p) => p.name));

console.log('-- fix 3: filter keeps only football sections --');
const f = sp.filterToFootballSections(au);
ok('filtered', f.filtered === true, f.filtered);
ok('kept the 5 football people', f.staff.length === 5, f.staff.map((p) => p.name));
ok('dropped the other 4', f.dropped === 4, f.dropped);
ok('swim coach gone', !f.staff.some((p) => p.name === 'Sample Hotel'), null);
ok('trainer gone', !f.staff.some((p) => p.name === 'Sample Echo'), null);
ok('the 4 named support staff survived',
  ['Andrew Warsaw', 'Alex Fagan', 'Harding Harper III', 'Luke Haker']
    .every((n) => f.staff.some((p) => p.name === n)),
  f.staff.map((p) => p.name));

console.log('-- fix 3: a football-only page is NOT filtered --');
const florida = `<html><body><table>
<tr><td>Fixture India</td><td>Head Coach</td></tr>
<tr><td>Fixture Juliett</td><td>General Manager</td></tr>
<tr><td>Fixture Kilo</td><td>Director of Player Personnel</td></tr>
<tr><td>Fixture Lima</td><td>Director of Recruiting</td></tr>
</table></body></html>`;
const fl = sp.parseStaffHtml(florida, 'https://floridagators.com/sports/football/coaches/');
const ff = sp.filterToFootballSections(fl);
ok('no sections means no filtering', ff.filtered === false, ff.filtered);
ok('everyone kept', ff.staff.length === 4, ff.staff.length);

console.log('-- fix 3: a title naming football survives a non-football section --');
const crossSection = `<html><body><table>
<tr><th>Football</th></tr>
<tr><td>Fixture Mike</td><td>Head Coach</td></tr>
<tr><td>Fixture November</td><td>General Manager</td></tr>
<tr><td>Fixture Oscar</td><td>Director of Recruiting</td></tr>
<tr><th>Sports Medicine</th></tr>
<tr><td>Fixture Papa</td><td>Associate Athletic Trainer, Football</td></tr>
<tr><td>Fixture Quebec</td><td>Associate Athletic Trainer, Volleyball</td></tr>
</table></body></html>`;
const cs = sp.filterToFootballSections(sp.parseStaffHtml(crossSection, 'https://x.com/s/'));
ok('football trainer kept despite his section',
  cs.staff.some((p) => p.name === 'Fixture Papa'), cs.staff.map((p) => p.name));
ok('volleyball trainer dropped',
  !cs.staff.some((p) => p.name === 'Fixture Quebec'), cs.staff.map((p) => p.name));

console.log('-- fix 3: never filter down to nothing --');
const almostEmpty = `<html><body><table>
<tr><th>Football</th></tr>
<tr><td>Fixture Romeo</td><td>Equipment Manager</td></tr>
<tr><th>Sports Medicine</th></tr>
<tr><td>Fixture Sierra</td><td>Head Athletic Trainer</td></tr>
<tr><td>Fixture Tango</td><td>Associate Athletic Trainer</td></tr>
<tr><td>Fixture Uniform</td><td>Assistant Athletic Trainer</td></tr>
</table></body></html>`;
const ae = sp.filterToFootballSections(sp.parseStaffHtml(almostEmpty, 'https://x.com/s/'));
ok('1 football row is too few to trust, keep the full list', ae.filtered === false, ae.filtered);
ok('nothing dropped', ae.staff.length === 4, ae.staff.length);

// ── FIX 2: quality score ────────────────────────────────────────────────────
console.log('-- fix 2: Alabama 381-row junk page is REJECTED --');
const junkRows = [];
for (let i = 0; i < 381; i++) junkRows.push({ name: `Full Bio for Fixture Person${i}`, title: null });
const junkScore = sp.scoreStaffPage(junkRows, ROLE_PATS);
ok('rejected', junkScore.accepted === false, junkScore);
ok('fails the title rule', junkScore.reasons.some((r) => /title/.test(r)), junkScore.reasons);
ok('fails the junk rule', junkScore.reasons.some((r) => /junk/.test(r)), junkScore.reasons);
ok('fails the key-role rule', junkScore.reasons.some((r) => /key roles/.test(r)), junkScore.reasons);
ok('all three rules fire, as the user predicted', junkScore.reasons.length === 3, junkScore.reasons);

console.log('-- fix 2: Alabama 19-row real page is ACCEPTED --');
const realRows = [
  { name: 'Kalen DeBoer', title: 'Head Coach' },
  { name: 'Courtney Morgan', title: 'General Manager' },
  { name: 'Bob Welton', title: 'Director of Player Personnel' },
  { name: 'Fixture Victor', title: 'Director of Recruiting' },
];
// Filler names must be digit-free AND free of role words: looksLikeName rejects both,
// which is correct, and a fixture that ignores it reports its own names as junk.
const SURNAMES = ['Aldridge', 'Bramwell', 'Castellan', 'Danforth', 'Ellsworth', 'Farrow',
  'Gathright', 'Hollingsworth', 'Ingerson', 'Jessup', 'Kentwood', 'Ledbetter', 'Marchetti',
  'Northrup', 'Ostrander'];
for (let i = 0; i < 15; i++) realRows.push({ name: `Fixture ${SURNAMES[i]}`, title: 'Assistant Coach' });
const realScore = sp.scoreStaffPage(realRows, ROLE_PATS);
ok('accepted', realScore.accepted === true, realScore);
ok('19 rows', realScore.rows === 19, realScore.rows);
ok('100% titled', realScore.titleRate === 1, realScore.titleRate);
ok('4 key roles present', realScore.keyRoles === 4, realScore.keyRoles);

console.log('-- fix 2: each rule fires on its own --');
const titleMiss = [
  { name: 'Fixture Whiskey', title: 'Head Coach' },
  { name: 'Fixture Xray', title: 'General Manager' },
  { name: 'Fixture Yankee', title: 'Director of Recruiting' },
  { name: 'Fixture Zulu', title: null },
  { name: 'Sample Alpha', title: null },
];
const tm = sp.scoreStaffPage(titleMiss, ROLE_PATS);
ok('60% titles is exactly at the bar and passes', tm.accepted === true, tm);
const tm2 = sp.scoreStaffPage([...titleMiss, { name: 'Sample Bravo', title: null }], ROLE_PATS);
ok('50% titles fails', tm2.accepted === false && tm2.reasons.some((r) => /title/.test(r)), tm2.reasons);

const roleMiss = [
  { name: 'Fixture Alpha', title: 'Equipment Manager' },
  { name: 'Fixture Bravo', title: 'Video Coordinator' },
  { name: 'Fixture Charlie', title: 'Creative Director' },
  { name: 'Fixture Delta', title: 'Nutrition Specialist' },
];
const rm = sp.scoreStaffPage(roleMiss, ROLE_PATS);
ok('titled rows with no key roles still fail', rm.accepted === false, rm.reasons);
ok('only the key-role rule fires', rm.reasons.length === 1 && /key roles/.test(rm.reasons[0]), rm.reasons);

ok('an empty page is rejected', sp.scoreStaffPage([], ROLE_PATS).accepted === false, null);

// ── FIX 1: verified URLs ────────────────────────────────────────────────────
console.log('-- fix 1: Alabama is restored and locked --');
function mkStore(initial) {
  const state = { src: initial || null, saved: [] };
  return { state,
    getProgramSource: async () => state.src,
    saveProgramSourceUrl: async (school, url, via) => {
      state.saved.push({ school, url, via });
      // The real store writes staff_url and adds the football_staff_url alias on the
      // way out. The fixture does both, or it is testing a column that no longer exists.
      state.src = { ...(state.src || {}), staff_url: url, football_staff_url: url, url_locked: via === 'manual' };
      return true;
    } };
}
(async () => {
  let store = mkStore({ staff_url: 'https://rolltide.com/staff-directory', football_staff_url: 'https://rolltide.com/staff-directory', last_staff_count: 381 });
  await pm.sweepStaffUrl('Alabama', store, {});
  const first = store.state.saved[0];
  ok('restored the coaches page', first && first.url === 'https://rolltide.com/sports/football/coaches',
    first);
  ok('stored as manual, which locks it', first && first.via === 'manual', first);

  console.log('-- fix 1: a hand-set URL still beats the verified list --');
  store = mkStore({ staff_url: 'https://my.own/choice', football_staff_url: 'https://my.own/choice', url_locked: true });
  const r = await pm.sweepStaffUrl('Alabama', store, {});
  ok('kept the hand-set URL', r.url === 'https://my.own/choice', r.url);
  ok('wrote nothing', store.state.saved.length === 0, store.state.saved);

  console.log('-- fix 1: schools with no verified URL are unaffected --');
  ok('Auburn is not in the verified list, it needs section filtering not a new URL',
    !Object.keys(pm.VERIFIED_STAFF_URLS || {}).includes('Auburn'),
    Object.keys(pm.VERIFIED_STAFF_URLS || {}));

  console.log('');
  console.log('failures: ' + fails);
  process.exit(fails ? 1 : 0);
})();
