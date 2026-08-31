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
// Missouri: ALL CAPS department headings, plus the header markup shapes that a
// heading-tag-only parser would miss entirely.
const path = require('path');
const AI = path.resolve(REPO + 'server/ai.js');
require.cache[AI] = { id: AI, filename: AI, loaded: true, exports: { oneShot: async () => '', MODEL_FAST: 'x' } };
const sp = require(REPO + 'server/services/staffPage.js');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

console.log('-- matching was ALREADY case-insensitive --');
ok('the regex carries the i flag', sp.FOOTBALL_SECTION.flags.includes('i'), sp.FOOTBALL_SECTION.flags);
for (const s of ['FOOTBALL', 'FOOTBALL OPERATIONS', 'Football Support Staff', 'football ops', 'FoOtBaLl']) {
  ok(`${JSON.stringify(s)} matches`, sp.FOOTBALL_SECTION.test(s), s);
}
ok('BUSINESS OPERATIONS does not match', sp.FOOTBALL_SECTION.test('BUSINESS OPERATIONS') === false, null);
ok('EQUIPMENT OPERATIONS does not match', sp.FOOTBALL_SECTION.test('EQUIPMENT OPERATIONS') === false, null);

console.log('-- ALL CAPS headings filter correctly end to end --');
const caps = `<html><body><table>
<tr><th>BUSINESS OPERATIONS</th></tr>
<tr><td>Fixture Aldridge</td><td>Chief Financial Officer</td></tr>
<tr><td>Fixture Bramwell</td><td>Business Manager</td></tr>
<tr><th>EQUIPMENT OPERATIONS</th></tr>
<tr><td>Fixture Castellan</td><td>Equipment Manager</td></tr>
<tr><th>FOOTBALL OPERATIONS</th></tr>
<tr><td>Fixture Danforth</td><td>Head Coach</td></tr>
<tr><td>Fixture Ellsworth</td><td>General Manager</td></tr>
<tr><td>Fixture Farrow</td><td>Director of Player Personnel</td></tr>
<tr><td>Fixture Gathright</td><td>Director of Recruiting</td></tr>
</table></body></html>`;
const c = sp.parseStaffHtml(caps, 'https://mutigers.com/staff-directory');
ok('all caps headings detected', c._sections.join('|') === 'BUSINESS OPERATIONS|EQUIPMENT OPERATIONS|FOOTBALL OPERATIONS',
  c._sections);
const cf = sp.filterToFootballSections(c);
ok('filtered on an all-caps football section', cf.filtered === true, cf.filtered);
ok('kept exactly the 4 football people', cf.staff.length === 4, cf.staff.map((p) => p.name));
ok('dropped the other 3', cf.dropped === 3, cf.dropped);

console.log('-- normalizeSection strips heading decoration --');
ok('trailing count removed', sp.normalizeSection('FOOTBALL OPERATIONS (12)') === 'FOOTBALL OPERATIONS',
  sp.normalizeSection('FOOTBALL OPERATIONS (12)'));
ok('trailing colon removed', sp.normalizeSection('Football Staff:') === 'Football Staff',
  sp.normalizeSection('Football Staff:'));
ok('collapses whitespace', sp.normalizeSection('  FOOTBALL   OPERATIONS  ') === 'FOOTBALL OPERATIONS',
  sp.normalizeSection('  FOOTBALL   OPERATIONS  '));
ok('non-breaking space handled', sp.normalizeSection('FOOTBALL OPERATIONS') === 'FOOTBALL OPERATIONS',
  sp.normalizeSection('FOOTBALL OPERATIONS'));
ok('a decorated heading still matches football',
  sp.FOOTBALL_SECTION.test(sp.normalizeSection('FOOTBALL OPERATIONS (12)')), null);

console.log('-- headings that are NOT heading tags are now detected --');
const divHeaders = `<html><body>
<div class="c-staff__section-title">BUSINESS OPERATIONS</div>
<table>
<tr><td>Fixture Hollingsworth</td><td>Chief Financial Officer</td></tr>
<tr><td>Fixture Ingerson</td><td>Business Manager</td></tr>
</table>
<div class="c-staff__section-title">FOOTBALL</div>
<table>
<tr><td>Fixture Jessup</td><td>Head Coach</td></tr>
<tr><td>Fixture Kentwood</td><td>General Manager</td></tr>
<tr><td>Fixture Ledbetter</td><td>Director of Player Personnel</td></tr>
</table></body></html>`;
const dh = sp.parseStaffHtml(divHeaders, 'https://mutigers.com/staff-directory');
ok('div-class headings detected', dh._sections.includes('FOOTBALL'), dh._sections);
const dhf = sp.filterToFootballSections(dh);
ok('div-header page filters', dhf.filtered === true, dhf.filtered);
ok('kept the 3 football people', dhf.staff.length === 3, dhf.staff.map((p) => p.name));

console.log('-- a table caption counts as a section heading --');
const cap = `<html><body>
<table><caption>Business Operations</caption>
<tr><td>Fixture Marchetti</td><td>Business Manager</td></tr></table>
<table><caption>Football Operations</caption>
<tr><td>Fixture Northrup</td><td>Head Coach</td></tr>
<tr><td>Fixture Ostrander</td><td>General Manager</td></tr>
<tr><td>Fixture Aldridge</td><td>Director of Recruiting</td></tr></table>
</body></html>`;
const cp = sp.filterToFootballSections(sp.parseStaffHtml(cap, 'https://x.com/s/'));
ok('caption headings work', cp.filtered === true, cp.filtered);
ok('kept 3', cp.staff.length === 3, cp.staff.map((p) => p.name));

console.log('-- a heading INSIDE a staff card does not reset the section --');
const nested = `<html><body>
<div class="c-staff__section-title">FOOTBALL</div>
<li class="staff-card"><h3>Fixture Bramwell</h3><span>Head Coach</span></li>
<li class="staff-card"><h3>Fixture Castellan</h3><span>General Manager</span></li>
<li class="staff-card"><h3>Fixture Danforth</h3><span>Director of Recruiting</span></li>
</body></html>`;
const nst = sp.parseStaffHtml(nested, 'https://x.com/s/');
ok('all three parsed', nst.length === 3, nst.map((p) => p.name));
ok('all three kept the FOOTBALL section',
  nst.every((p) => p.section === 'FOOTBALL'), nst.map((p) => [p.name, p.section]));

console.log('-- the guard still holds: no football section means no filtering --');
const noFootball = `<html><body><table>
<tr><th>BUSINESS OPERATIONS</th></tr>
<tr><td>Fixture Ellsworth</td><td>Chief Financial Officer</td></tr>
<tr><th>EQUIPMENT OPERATIONS</th></tr>
<tr><td>Fixture Farrow</td><td>Equipment Manager</td></tr>
<tr><td>Fixture Gathright</td><td>Assistant Equipment Manager</td></tr>
</table></body></html>`;
const nf = sp.filterToFootballSections(sp.parseStaffHtml(noFootball, 'https://x.com/s/'));
ok('not filtered', nf.filtered === false, nf.filtered);
ok('everyone kept, 373 beats 0', nf.staff.length === 3, nf.staff.length);
ok('the sections are reported so the reason is visible',
  nf.sections.join('|') === 'BUSINESS OPERATIONS|EQUIPMENT OPERATIONS', nf.sections);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
