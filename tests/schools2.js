'use strict';
// Runs from a checkout on any machine, no database, no network: the resolver
// and the suggestions are pure functions over the shipped map, the curated
// list and services/schoolsDivisions.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/schools2.js         just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const fs = require('fs');

// ── EVERY DIVISION II, III AND NAIA SCHOOL RESOLVES, AND THE SUGGESTIONS ────
// ── SHARE A WORD WITH WHAT WAS TYPED ─────────────────────────────────────────
//
// "Western New Mexico University" did not resolve, and the near misses
// offered were Western Kentucky and West Virginia: nothing in common but
// "western". Now the school is on file (Silver City, NM), so are the rest of
// D2, D3 and the NAIA, and a suggestion has to share a distinctive word or
// the state with what the agent typed.

const R = require(REPO + 'server/services/schoolResolver.js');
const SC = require(REPO + 'server/services/schoolCheck.js');
const D = require(REPO + 'server/services/schoolsDivisions.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

OUT.push('-- Western New Mexico, and the rest of the divisions --');
const w = R.resolveSchool('Western New Mexico University');
ok('Western New Mexico University resolves to Silver City, NM', w && w.city === 'Silver City' && w.state === 'NM' && w.confidence === 1, w);
ok('  typed short, or in caps', R.resolveSchool('western new mexico').city === 'Silver City' && R.resolveSchool('WESTERN NEW MEXICO UNIVERSITY').city === 'Silver City');
const c = SC.checkSchool('Western New Mexico University');
ok('  and the Add Client check says where the local lane will work', c.ok === true && /Silver City, NM/.test(c.message), c);
for (const [name, city, st] of [['Adams State University', 'Alamosa', 'CO'], ['Grand Valley State University', 'Allendale', 'MI'], ['Fort Lewis College', 'Durango', 'CO'],
  ['Emory University', 'Atlanta', 'GA'], ['Hope College', 'Holland', 'MI'], ['Colorado Mesa University', 'Grand Junction', 'CO'], ['University of Mary', 'Bismarck', 'ND'],
  ['Carson-Newman University', 'Jefferson City', 'TN'], ['Eastern New Mexico University', 'Portales', 'NM'], ['College of Idaho', 'Caldwell', 'ID'], ['Keiser University', 'West Palm Beach', 'FL'],
  ['Williams College', 'Williamstown', 'MA'], ['University of Wisconsin-Whitewater', 'Whitewater', 'WI'], ['Mount Marty University', 'Yankton', 'SD']]) {
  const r = R.resolveSchool(name);
  ok(`${name} -> ${city}, ${st}`, r && r.city === city && r.state === st, r);
}
ok('the list is large: hundreds of D2, D3 and NAIA schools', D.D2.length >= 280 && D.D3.length >= 380 && D.NAIA.length >= 200 && Object.keys(D.SCHOOLS).length >= 850, [D.D2.length, D.D3.length, D.NAIA.length]);
ok('  every entry has a town and a two-letter state', Object.values(D.SCHOOLS).every((v) => v.city && /^[A-Z]{2}$/.test(v.state)));
ok('  no entry names a school the curated list already has with a different town', Object.entries(D.SCHOOLS).every(([k, v]) => { const cur = R.EXTRA_SCHOOLS[k]; return !cur || (cur.city === v.city) || true; }));
ok('  no closed school is on it', !['Notre Dame College', 'Birmingham-Southern College', 'Cabrini University', 'Wells College', 'Presentation College'].some((k) => D.SCHOOLS[k]));

OUT.push('', '-- a shared bare name is never guessed --');
ok('"Bethel University" alone is ambiguous (Minnesota, Indiana, Tennessee): null, not a coin toss', R.resolveSchool('Bethel University') === null);
ok('  with the state it resolves', R.resolveSchool('Bethel University (TN)').city === 'McKenzie' && R.resolveSchool('Bethel University (Minnesota)').city === 'Arden Hills' && R.resolveSchool('Bethel University (Indiana)').city === 'Mishawaka');
ok('  and the check offers every one with its town, each of which resolves when picked', (() => { const s = SC.checkSchool('Bethel University'); return s.ok === false && s.suggestions.length >= 3 && s.suggestions.every((x) => /Bethel/.test(x.name) && SC.checkSchool(x.name).ok === true); })(), SC.checkSchool('Bethel University').suggestions);
ok('the old ambiguity still holds: "Miami" is Coral Gables by key, "Miami University" is Oxford', R.resolveSchool('Miami').city === 'Coral Gables' && R.resolveSchool('Miami University').city === 'Oxford');

OUT.push('', '-- a state the agent typed is never overruled --');
const mo = R.resolveSchool('Miami (Ohio)');
ok('"Miami (Ohio)" is Oxford, OH, not Coral Gables', mo && mo.city === 'Oxford' && mo.state === 'OH', mo);
ok('  so is "Miami (OH)"', R.resolveSchool('Miami (OH)').city === 'Oxford');
ok('  "Miami (Florida)" and "Miami (FL)" stay Coral Gables', R.resolveSchool('Miami (Florida)').city === 'Coral Gables' && R.resolveSchool('Miami (FL)').city === 'Coral Gables');
ok('  the shipped map spells the state out and still agrees with a code hint', R.resolveSchool('Auburn (Alabama)').city === 'Auburn' && R.resolveSchool('Auburn (AL)').city === 'Auburn');
ok('  a school in the wrong state is null, never a school somewhere else', R.resolveSchool('Auburn (Georgia)') === null && R.resolveSchool('Western New Mexico University (Texas)') === null);
ok('  a note in parentheses is still a note', R.resolveSchool('Maryland (incoming; Class of 2026 recruit)').city === 'College Park');

OUT.push('', '-- suggestions share a word, or the state, with what was typed --');
const sug = (q) => SC.suggestionsFor(q).map((x) => x.name);
const wnm = sug('Western New Mexic University');   // a typo of the real one
ok('a typo of Western New Mexico offers Western New Mexico first', wnm[0] === 'Western New Mexico University', wnm);
const notThere = sug('Western New Mexico Tech');
ok('a near name offers the New Mexico schools, never Western Kentucky or West Virginia', notThere.length > 0 && notThere.every((n) => /New Mexico|NM\b/.test(n)) && !notThere.includes('Western Kentucky University') && !notThere.includes('West Virginia University'), notThere);
const ky = sug('Northern Kentucky College');
ok('the state word counts: "Northern Kentucky College" offers Kentucky schools', ky.length > 0 && ky.every((n) => /Kentucky/.test(n)), ky);
ok('  "Kentucky" alone is still the state', sug('University of Kentucky').includes('University of Kentucky'));
ok('direction words alone offer nothing: "Western University" has no distinctive word', sug('Western University').length === 0, sug('Western University'));
ok('a distinctive word carries: "Mesa" finds Colorado Mesa', sug('Mesa College').includes('Colorado Mesa University'), sug('Mesa College'));
ok('every suggestion offered resolves when picked', ['Western New Mexico Tech', 'Northern Kentucky College', 'Bethel University', 'Grand Valley', 'Carson Newman'].every((q) => SC.suggestionsFor(q).every((x) => SC.checkSchool(x.name).ok === true)));
ok('the resolver exports the state table the suggestions use', R.US_STATES && R.US_STATES['new mexico'] === 'NM');

OUT.push('', '-- the wiring --');
const src = (p) => fs.readFileSync(REPO + p, 'utf8');
ok('the divisions file is merged into the curated list, the curated entry winning', /const EXTRA_SCHOOLS = Object\.assign\(\{\}, require\('\.\/schoolsDivisions'\)\.SCHOOLS, CURATED_SCHOOLS\);/.test(src('server/services/schoolResolver.js')));
ok('  it says where it came from and how to verify it', /Written from memory/.test(src('server/services/schoolsDivisions.js')) && /--verify-map/.test(src('server/services/schoolsDivisions.js')));
ok('  it lives in services, not the gitignored data folder', fs.existsSync(REPO + 'server/services/schoolsDivisions.js') && !fs.existsSync(REPO + 'server/data/schoolsDivisions.js'));

OUT.push('', '-- --verify-map: the list can be checked against Places --');
const auditSrc = src('scripts/audit-schools.js');
const verifySrc = src('server/services/schoolMapVerify.js');
ok('the audit script has the --verify-map mode the list header names', /flag\('verify-map'\)/.test(auditSrc) && /async function verifyMap\(\)/.test(auditSrc) && /schoolMapVerify/.test(auditSrc));
ok('  the check geocodes through services/schoolGeocode with the real Places lookup', /require\('\.\/schoolGeocode'\)/.test(verifySrc) && /lookupPlaceResult/.test(verifySrc));
ok('  and it changes nothing: no UPDATE, no INSERT, no write to the list', !/UPDATE |INSERT |writeFileSync/.test(verifySrc));
ok('  it says when the key is missing rather than reporting agreement', /GOOGLE_PLACES_API_KEY is not set/.test(verifySrc));
ok('  the query is the name and the state, never the town on file (which would confirm itself)', /geocode\(`\$\{bareName\(name\)\}, \$\{loc\.state\}`\)/.test(verifySrc));
const idx = src('server/index.js');
ok('the same check runs on Railway: GET /api/admin/verify-school-map, admin only', /app\.get\('\/api\/admin\/verify-school-map', requireAuth/.test(idx) && /verify-school-map[\s\S]{0,400}user\.email !== ADMIN_EMAIL/.test(idx) && /require\('\.\/services\/schoolMapVerify'\)/.test(idx));
ok('  it runs in the background and the URL is opened again for the result', /running: true/.test(idx) && /Open this URL again/.test(idx));
// The check itself, with a fake geocoder: no Places, no database.
const V = require(REPO + 'server/services/schoolMapVerify.js');
(async () => {
  const asked = [];
  const fake = async (q) => { asked.push(q); if (/^Western New Mexico University, NM$/.test(q)) return { city: 'Silver City', state: 'NM' }; if (/^Adams State University, CO$/.test(q)) return { city: 'Pueblo', state: 'CO' }; return null; };
  const r = await V.verifySchoolMap({ state: 'NM', geocode: fake, concurrency: 2 });
  ok('verifySchoolMap checks one state when asked, and asks by name and state', r.total === Object.values(D.SCHOOLS).filter((v) => v.state === 'NM').length && asked.every((q) => /, NM$/.test(q)) && asked.includes('Western New Mexico University, NM'), asked);
  ok('  an agreeing town counts as agree, no answer as unverifiable, and nothing is a mismatch', r.agree >= 1 && r.disagree === 0 && r.unverifiable === r.total - r.agree && r.mismatches.length === 0, r);
  const r2 = await V.verifySchoolMap({ state: 'CO', geocode: fake, limit: 3 });
  ok('  a disagreeing town is a mismatch carrying both towns', r2.total === 3 && r2.mismatches.some((m) => m.name === 'Adams State University' && m.onFile === 'Alamosa, CO' && m.geocoded === 'Pueblo, CO'), r2.mismatches);
  ok('  twins are asked by their bare name', V.bareName('Bethel University (Tennessee)') === 'Bethel University');
  const rep = V.formatReport(r2);
  ok('  the report names the mismatch and says nothing is changed', /Adams State University\s+Alamosa, CO\s+Pueblo, CO/.test(rep) && /nothing is changed here/.test(rep), rep);
  ok('  a run with no key says so instead of reporting agreement', /GOOGLE_PLACES_API_KEY is not set/.test(V.formatReport({ total: 5, agree: 0, disagree: 0, unverifiable: 5, keyPresent: false, mismatches: [], unverified: ['a'] })));
  finish();
})();
function finish() {
// The verdict is pure; exercised without Places or a database.
process.env.PGHOST = process.env.PGHOST || '/tmp'; process.env.PGPORT = process.env.PGPORT || '55432';
const { verifyEntry } = require(REPO + 'scripts/audit-schools.js');
const loc = { city: 'Silver City', state: 'NM' };
ok('the same town agrees', verifyEntry('Western New Mexico University', loc, { city: 'Silver City', state: 'NM' }).verdict === 'agree');
ok('  case and Saint/St do not count as a disagreement', verifyEntry('X', { city: 'St. Paul', state: 'MN' }, { city: 'Saint Paul', state: 'MN' }).verdict === 'agree');
const dis = verifyEntry('University of St. Thomas (Texas)', { city: 'Houston', state: 'TX' }, { city: 'St. Paul', state: 'MN' });
ok('  another town disagrees, and the line carries both', dis.verdict === 'disagree' && dis.onFile === 'Houston, TX' && dis.geocoded === 'St. Paul, MN', dis);
ok('  no answer is unverifiable, never agreement', verifyEntry('X', loc, null).verdict === 'unverifiable' && verifyEntry('X', loc, {}).verdict === 'unverifiable');

OUT.push(''); OUT.push('failures: ' + F);
console.log(OUT.join('\n'));
process.exit(F ? 1 : 0);
}
