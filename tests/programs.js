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
// Programs tab. Client render functions are pulled OUT OF public/index.html and run
// as shipped, so these test the real code rather than a copy of it.
const fs = require('fs');
const HTML = fs.readFileSync(REPO + 'public/index.html', 'utf8');
const SRV = fs.readFileSync(REPO + 'server/index.js', 'utf8');

let fails = 0;
function ok(label, cond, got) {
  if (cond) console.log('  PASS ' + label);
  else { console.log('  FAIL ' + label + '  got=' + JSON.stringify(got)); fails++; }
}

// Pull a named function out of the shipped file by brace matching.
function grab(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('function not found: ' + name);
  let depth = 0, i = src.indexOf('{', start);
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (!depth) return src.slice(start, j + 1); }
  }
  throw new Error('unbalanced: ' + name);
}

const NAMES = ['progEsc', 'progContactLine', 'progSourceLink', 'progCopyBtn', 'progAgo', 'progRender',
  'progFilterFull', 'progToggleFull'];
let bundle = NAMES.map((n) => grab(HTML, n)).join('\n');

// Minimal DOM: the render functions only read/write innerHTML on known ids.
const dom = {};
const sandbox = {
  _progCurrent: null,
  document: {
    getElementById: (id) => (dom[id] = dom[id] || { id, innerHTML: '', style: {}, value: '', textContent: '' }),
  },
  Date,
  JSON,
  navigator: {},
  console,
};
const fn = new Function('sandbox', `
  with (sandbox) {
    ${bundle}
    return { progEsc, progContactLine, progSourceLink, progCopyBtn, progAgo, progRender,
             progFilterFull, progToggleFull,
             setCurrent: (d) => { sandbox._progCurrent = d; } };
  }
`);
const P = fn(sandbox);
// Nodes the render functions read but never create themselves.
const node = (id) => sandbox.document.getElementById(id);
const setVal = (id, v) => { node(id).value = v; };

// ── Never invent a contact ──────────────────────────────────────────────────
console.log('-- a missing contact renders NOTHING, not a guess --');
ok('null email renders empty string', P.progContactLine(null, 'mailto:', 'email') === '', P.progContactLine(null, 'x', 'e'));
ok('empty email renders empty string', P.progContactLine('', 'mailto:', 'email') === '', null);
ok('undefined phone renders empty string', P.progContactLine(undefined, 'tel:', 'phone') === '', null);
ok('a real email renders a mailto', /mailto:a@b\.edu/.test(P.progContactLine('a@b.edu', 'mailto:a@b.edu', 'email')), null);
ok('no copy button when there is nothing to copy', P.progCopyBtn(null, 'email') === '', null);
ok('no source link when there is no url', P.progSourceLink(null) === '', null);

// ── Rendering a school ──────────────────────────────────────────────────────
const SCHOOL = {
  school: 'Ole Miss',
  officePhone: '803-777-4271',
  lastFetched: new Date(Date.now() - 3 * 86400000).toISOString(),
  totals: { shown: 23, stored: 81, hidden: 58, withEmail: 20, withPhone: 0 },
  keyContacts: [
    { role: 'general_manager', role_label: 'General Manager / Football Ops', name: 'Fixture Aldridge',
      title: 'General Manager', email: 'aldridge@olemiss.edu', phone: null,
      source_url: 'https://olemisssports.com/sports/football/coaches', others_in_role: 1 },
    { role: 'player_personnel', role_label: 'Player Personnel', name: 'Fixture Bramwell',
      title: 'Director of Player Personnel', email: 'bramwell@olemiss.edu', phone: '662-555-0143',
      source_url: 'https://olemisssports.com/sports/football/coaches', others_in_role: 0 },
    { role: 'recruiting', role_label: 'Recruiting', name: 'Fixture Castellan',
      title: 'Director of Recruiting', email: null, phone: null,
      source_url: 'https://olemisssports.com/sports/football/coaches', others_in_role: 0 },
    { role: 'head_coach', role_label: 'Head Coach', name: 'Fixture Danforth',
      title: 'Head Football Coach', email: 'danforth@olemiss.edu', phone: null,
      source_url: 'https://olemisssports.com/sports/football/coaches', others_in_role: 0 },
  ],
  fullStaff: [
    { name: 'Fixture Ellsworth', title: 'Assistant Coach', email: 'e@olemiss.edu', phone: null },
    { name: 'Fixture Farrow', title: 'Equipment Manager', email: null, phone: null },
    { name: 'Fixture Gathright', title: 'Video Coordinator', email: 'g@olemiss.edu', phone: null },
  ],
};

P.progRender(SCHOOL);
const html = node('prog-body').innerHTML;

console.log('-- header --');
ok('names the school', /Ole Miss/.test(html), null);
ok('shows the FILTERED count, labelled as decision makers',
  /23 decision makers, 20 with an email/.test(html), null);
ok('says how many are hidden, so 23 does not read as the whole roster',
  /58 support and development staff not shown/.test(html), null);
ok('never claims 23 is the staff total', !/23 staff/.test(html), null);
ok('shows how current it is', /last checked 3 days ago/.test(html), null);
ok('shows the office line', /803-777-4271/.test(html), null);
ok('office line is dialable', /tel:803-777-4271/.test(html), null);

console.log('-- key contacts, in the order asked for --');
const order = ['General Manager / Football Ops', 'Player Personnel', 'Recruiting', 'Head Coach'];
const positions = order.map((l) => html.indexOf(l));
ok('all four labels present', positions.every((p) => p > -1), positions);
ok('they appear in the required order',
  positions.every((p, i) => i === 0 || p > positions[i - 1]), positions);
ok('each shows the exact published title', /Head Football Coach/.test(html) && /Director of Player Personnel/.test(html), null);

console.log('-- the recruiting director has no email, so none is shown --');
ok('no invented address for the contactless person',
  html.indexOf('castellan@') === -1 && html.indexOf('Fixture.Castellan') === -1, null);
ok('but the person is still listed', /Fixture Castellan/.test(html), null);
ok('and their title is shown', /Director of Recruiting/.test(html), null);
const emails = html.match(/mailto:[^"']+/g) || [];
ok('exactly the 3 real emails become mailto links', emails.length === 3, emails);

console.log('-- source links --');
ok('a source link per key contact', (html.match(/>source</g) || []).length === 4,
  (html.match(/>source</g) || []).length);
ok('source opens in a new tab safely', /target="_blank" rel="noopener"/.test(html), null);

console.log('-- others in role are surfaced, not hidden --');
ok('the GM notes 1 more in the role', /\+1 more in this role/.test(html), null);

console.log('-- full staff is collapsed by default --');
ok('toggle shows the count', /Full staff \(3\)/.test(html), null);
ok('the panel starts hidden', /id="prog-full" style="display:none/.test(html), null);

console.log('-- mobile --');
const targets = html.match(/min-height:4[48]px/g) || [];
ok('every interactive element declares a 44px+ target', targets.length >= 2, targets.length);
ok('no fixed pixel widths that would overflow a phone', !/width:\s*\d{3,}px/.test(html), null);
ok('inputs are 16px so iOS does not zoom on focus',
  !/prog-full-search[\s\S]{0,300}?font-size:1[0-5]px/.test(html), null);
ok('long emails wrap rather than overflow', /word-break:break-all/.test(html), null);

console.log('-- escaping --');
const nasty = JSON.parse(JSON.stringify(SCHOOL));
nasty.school = '<img src=x onerror=alert(1)>';
nasty.keyContacts[0].name = '<script>alert(2)</script>';
P.progRender(nasty);
const nastyHtml = node('prog-body').innerHTML;
ok('school name cannot inject', !/<img src=x/.test(nastyHtml), null);
ok('staff name cannot inject', !/<script>alert\(2\)/.test(nastyHtml), null);
ok('both are escaped', /&lt;img/.test(nastyHtml) && /&lt;script&gt;/.test(nastyHtml), null);

console.log('-- full staff filter --');
P.setCurrent(SCHOOL);
setVal('prog-full-search', '');
P.progFilterFull();
ok('empty filter shows everyone', (node('prog-full-list').innerHTML.match(/Fixture /g) || []).length === 3,
  (node('prog-full-list').innerHTML.match(/Fixture /g) || []).length);
setVal('prog-full-search', 'equipment');
P.progFilterFull();
ok('filters by TITLE', /Fixture Farrow/.test(node('prog-full-list').innerHTML)
  && !/Fixture Ellsworth/.test(node('prog-full-list').innerHTML), null);
setVal('prog-full-search', 'gathright');
P.progFilterFull();
ok('filters by NAME', /Fixture Gathright/.test(node('prog-full-list').innerHTML), null);
ok('says how many of how many', /Showing 1 of 3/.test(node('prog-full-list').innerHTML), null);
setVal('prog-full-search', 'zzzz');
P.progFilterFull();
ok('no match says so', /No one matches/.test(node('prog-full-list').innerHTML), null);
setVal('prog-full-search', 'EQUIPMENT');
P.progFilterFull();
ok('filter is case insensitive', /Fixture Farrow/.test(node('prog-full-list').innerHTML), null);

console.log('-- a person in full staff with no email shows no email --');
setVal('prog-full-search', 'farrow');
P.progFilterFull();
ok('no mailto for the contactless person',
  (node('prog-full-list').innerHTML.match(/mailto:/g) || []).length === 0,
  node('prog-full-list').innerHTML.match(/mailto:/g));

console.log('-- relative dates --');
ok('today', P.progAgo(new Date().toISOString()) === 'today', P.progAgo(new Date().toISOString()));
ok('yesterday', P.progAgo(new Date(Date.now() - 86400000).toISOString()) === 'yesterday', null);
ok('days', P.progAgo(new Date(Date.now() - 5 * 86400000).toISOString()) === '5 days ago', null);
ok('months', P.progAgo(new Date(Date.now() - 70 * 86400000).toISOString()) === '2 months ago', null);
ok('unknown when never fetched', P.progAgo(null) === 'unknown', null);

// ── Server side ─────────────────────────────────────────────────────────────
console.log('-- the server orders key roles as specified --');
const m = SRV.match(/const PROGRAM_KEY_ORDER = \[([^\]]+)\]/);
ok('PROGRAM_KEY_ORDER exists', !!m, null);
const roles = m[1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
ok('GM, personnel, recruiting, head coach, in that order',
  roles.join(',') === 'general_manager,player_personnel,recruiting,head_coach', roles);

console.log('-- the schools endpoint only returns schools with data --');
// Anchored on the named handler, not the path string: the handler was extracted so
// agents and athletes share one body, and the first occurrence of the path is now
// the registration line, which has no SQL in it.
const schoolsRoute = SRV.slice(SRV.indexOf('const _programsSchoolsHandler'), SRV.indexOf('const _programsSchoolsHandler') + 1400);
ok('groups by school', /GROUP BY ps\.school/.test(schoolsRoute), null);
ok('requires at least one row', /HAVING COUNT\(\*\) > 0/.test(schoolsRoute), null);
ok('only current records', /ps\.status = 'current'/.test(schoolsRoute), null);
ok('requires a signed-in user', /app\.get\('\/api\/programs\/schools', requireAuth/.test(SRV), null);
ok('the school route requires auth too', /app\.get\('\/api\/programs\/:school', requireAuth/.test(SRV), null);

console.log('-- the school endpoint 404s rather than inventing an empty school --');
// Same reason as the schools slice above: anchored on the named handler.
const oneRoute = SRV.slice(SRV.indexOf('const _programsSchoolHandler'), SRV.indexOf('const _programsSchoolHandler') + 3000);
// The message now names the sport ("no Men's Basketball data for that school"), so
// a 404 says WHICH sport is missing rather than implying the school is unknown.
ok('404 on no data', /status\(404\)[\s\S]{0,120}data for that school/.test(oneRoute), null);
ok('the 404 names the sport', /data for that school`, sport/.test(oneRoute), null);

console.log('-- sport is a parameter on both endpoints, and never a mix --');
ok('schools endpoint reads ?sport=', /_reqSport\(req, res\)/.test(SRV), null);
ok('schools query filters on the sport', /ps\.sport = \$1/.test(SRV), null);
ok('school endpoint passes sport to getProgramStaff', /getProgramStaff\(school, sport\)/.test(oneRoute), null);
ok('school endpoint passes sport to getProgramContact', /getProgramContact\(school, sport\)/.test(oneRoute), null);
ok('program_source is read for the sport too', /WHERE school = \$1 AND sport = \$2/.test(oneRoute), null);
ok('the decision-maker filter gets the sport', /partition\(rest, sport\)/.test(oneRoute), null);
ok('the response echoes the sport back', /\n      sport,\n/.test(oneRoute), null);
ok('an unknown sport is a 400, not a silent football fallback', /status\(400\)[\s\S]{0,80}unknown sport/.test(SRV), null);
ok('key order comes from the sport table for non-football', /_keyOrderFor\(sport\)/.test(oneRoute), null);
ok('only UI sports are offered to the client', /UI_SPORTS\.map/.test(SRV), null);
ok('email is passed through or null, never built', /email: top\.email \|\| null/.test(oneRoute), null);
ok('no string concatenation building an address',
  !/@['"] ?\+|\+ ?['"]@/.test(oneRoute), null);

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
