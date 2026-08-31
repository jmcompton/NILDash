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
// Sidearm person cards. The bug: a non-greedy </div> match truncated the card at the
// first closing tag, so the title and mailto that sit AFTER it were never seen.
const fs = require('fs');
const p = require('path');
const AI = p.resolve(REPO + 'server/ai.js');
require.cache[AI] = { id: AI, filename: AI, loaded: true, exports: { oneShot: async () => '', MODEL_FAST: 'x' } };
const sp = require(REPO + 'server/services/staffPage.js');
const JOB = fs.readFileSync(REPO + 'server/jobs/programMapPilot.js', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// THE MARYLAND SHAPE: title and contact are SIBLINGS of the name wrapper, so they
// sit after the first </div>. This is what produced 334 names and 0 titles.
function cardSibling(name, title, slug, extra) {
  return `
<div data-test-id="s-person-card-list__root" class="s-person-card s-person-card--list">
  <div class="s-person-card__content">
    <div class="s-person-details">
      <a href="/staff-directory/${slug}/4512" class="s-person-details__personal-single-line">${name}</a>
    </div>
    <div class="s-person-card__position">${title}</div>
    <div class="s-person-card__contact">${extra || `<a href="mailto:${slug}@umd.edu">Email</a>`}</div>
  </div>
</div>`;
}
// The other common shape: title nested INSIDE the name wrapper.
function cardNested(name, title, slug) {
  return `
<div class="s-person-card">
  <div class="s-person-card__content">
    <div class="s-person-details">
      <a href="/staff-directory/${slug}/1">${name}</a>
      <div class="s-person-details__position"><span>${title}</span></div>
    </div>
    <a href="mailto:${slug}@x.edu">Email</a>
  </div>
</div>`;
}

console.log('-- the Maryland shape now parses titles and emails --');
const md = sp.parseStaffHtml('<html><body>'
  + cardSibling('James E. Smith', 'Head Football Coach', 'james-e-smith')
  + cardSibling('Fixture Bramwell', 'Director of Player Personnel', 'fixture-bramwell')
  + cardSibling('Fixture Castellan', 'Director of Recruiting', 'fixture-castellan')
  + '</body></html>', 'https://umterps.com/x');
ok('3 people', md.length === 3, md.length);
ok('3 titles, was 0', md.filter((x) => x.title).length === 3, md.map((x) => x.title));
ok('3 emails, was 0', md.filter((x) => x.email).length === 3, md.map((x) => x.email));
ok('the head coach title is exact', md[0].title === 'Head Football Coach', md[0].title);
ok('the name is clean, not run together with the title',
  md[0].name === 'James E. Smith', md[0].name);

console.log('-- the nested shape still works --');
const nested = sp.parseStaffHtml('<html><body>'
  + cardNested('Fixture Danforth', 'General Manager', 'fixture-danforth')
  + cardNested('Fixture Ellsworth', 'Head Coach', 'fixture-ellsworth')
  + '</body></html>', 'https://x.com/s/');
ok('2 people', nested.length === 2, nested.length);
ok('both titled', nested.filter((x) => x.title).length === 2, nested.map((x) => x.title));
ok('both have emails', nested.filter((x) => x.email).length === 2, nested.map((x) => x.email));

console.log('-- one card yields ONE person, not one per inner wrapper --');
// The card has 4 nested divs. A naive collector would emit a person for each.
ok('no duplicate people from nesting', md.length === 3, md.map((x) => x.name));
const names = md.map((x) => x.name);
ok('names are distinct', new Set(names).size === names.length, names);

console.log('-- aria-label is read only when nothing else has the title --');
const ariaOnly = sp.parseStaffHtml(`<html><body>
<div class="s-person-card"><div class="s-person-details">
  <a href="/staff-directory/x/1" aria-label="Fixture Farrow - Director of Player Personnel">Fixture Farrow</a>
</div></div></body></html>`, 'https://x.com/s/');
ok('title recovered from aria-label',
  ariaOnly.length === 1 && ariaOnly[0].title === 'Director of Player Personnel',
  ariaOnly);
ok('the name is not polluted by the label', ariaOnly[0].name === 'Fixture Farrow', ariaOnly[0].name);

console.log('-- aria-label never invents a title that is not a title --');
const ariaJunk = sp.parseStaffHtml(`<html><body>
<div class="s-person-card"><div class="s-person-details">
  <a href="/staff-directory/x/1" aria-label="Fixture Gathright - View profile">Fixture Gathright</a>
</div></div></body></html>`, 'https://x.com/s/');
ok('a non-title aria-label is ignored',
  ariaJunk.length === 1 && ariaJunk[0].title === null, ariaJunk);

console.log('-- REGRESSION: table pages are unchanged --');
const table = sp.parseStaffHtml(`<html><body><table>
<tr><td>Fixture Hollingsworth</td><td>Head Football Coach</td><td><a href="mailto:h@x.edu">h@x.edu</a></td></tr>
<tr><td>Fixture Ingerson</td><td>General Manager</td><td><a href="mailto:i@x.edu">i@x.edu</a></td></tr>
<tr><td>Fixture Jessup</td><td>Director of Recruiting</td><td></td></tr>
</table></body></html>`, 'https://x.com/s/');
ok('3 rows', table.length === 3, table.length);
ok('all titled', table.filter((x) => x.title).length === 3, table.map((x) => x.title));
ok('2 emails, the third row has none and stays empty',
  table.filter((x) => x.email).length === 2, table.map((x) => x.email));

console.log('-- REGRESSION: section headers still work --');
const sectioned = sp.parseStaffHtml(`<html><body><table>
<tr><th>Football Support Staff</th></tr>
<tr><td>Fixture Kentwood</td><td>General Manager</td></tr>
<tr><th>Sports Medicine</th></tr>
<tr><td>Fixture Ledbetter</td><td>Head Athletic Trainer</td></tr>
</table></body></html>`, 'https://x.com/s/');
ok('sections attached', sectioned[0].section === 'Football Support Staff', sectioned[0].section);
ok('second section attached', sectioned[1].section === 'Sports Medicine', sectioned[1].section);

console.log('-- REGRESSION: junk rows still dropped --');
const junk = sp.parseStaffHtml(`<html><body><table>
<tr><td><a href="/x">Full Bio for Greg Byrne</a></td><td>Director of Athletics</td></tr>
<tr><td><a href="/y">All Rotators Playing</a></td></tr>
</table></body></html>`, 'https://x.com/s/');
ok('label stripped to the real name', junk.length === 1 && junk[0].name === 'Greg Byrne', junk.map((x) => x.name));

console.log('-- malformed markup cannot run away --');
const unclosed = sp.parseStaffHtml('<html><body><div class="s-person-card"><div class="s-person-details">'
  + '<a href="/staff-directory/x/1">Fixture Marchetti</a>' + 'x'.repeat(500) + '</body></html>', 'https://x.com/s/');
ok('an unclosed card does not throw', Array.isArray(unclosed), typeof unclosed);
const huge = '<div class="s-person-card">' + 'y'.repeat(60000);
ok('a runaway block is skipped rather than swallowing the page',
  Array.isArray(sp.parseStaffHtml('<html><body>' + huge + '</body></html>', 'https://x.com/s/')), null);

console.log('-- a real page mixing cards and a table --');
const mixed = sp.parseStaffHtml('<html><body>'
  + cardSibling('Fixture Northrup', 'General Manager', 'fixture-northrup')
  + '<table><tr><td>Fixture Ostrander</td><td>Director of Recruiting</td></tr></table>'
  + '</body></html>', 'https://x.com/s/');
ok('both shapes on one page', mixed.length === 2, mixed.map((x) => x.name));
ok('both titled', mixed.filter((x) => x.title).length === 2, mixed.map((x) => x.title));

console.log('-- the coverage reporting bug --');
ok('coverage measures ALL known schools, not the fetched subset',
  /const all = programMap\.ALL_SCHOOLS;/.test(JOB), null);
ok('the header says so explicitly',
  /known school\(s\), not just the \$\{targets\.length\} fetched in this run/.test(JOB), null);
ok('--only-zero also scans all known schools',
  /return programMap\.ALL_SCHOOLS\.filter/.test(JOB), null);
ok('its log line reports out of the full universe',
  /out of \$\{programMap\.ALL_SCHOOLS\.length\} known/.test(JOB), null);
ok('schoolList is no longer used for either count',
  !/const all = schoolList\(\);/.test(JOB), null);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
