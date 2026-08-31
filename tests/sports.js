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
const S = require(REPO + 'server/services/sports.js');
let fails = 0;
function ok(l, c, g) { if (c) console.log('  PASS ' + l); else { console.log('  FAIL ' + l + '  got=' + JSON.stringify(g)); fails++; } }
const MB = 'mens_basketball', WB = 'womens_basketball', FB = 'football';

console.log('-- the word-boundary trap: men inside women --');
ok('/\\bmen\\b/ does NOT match inside "women\'s"', !/\bmen'?s?\b/i.test("Women's Basketball"), null);
ok('so women\'s basketball is not mistaken for men\'s',
  S.namesSport("Women's Basketball", MB) === false, null);

console.log("-- Missouri's format: BASKETBALL, MEN'S --");
ok("men's scan accepts BASKETBALL, MEN'S", S.namesSport("BASKETBALL, MEN'S", MB) === true, null);
ok("men's scan REJECTS BASKETBALL, WOMEN'S", S.namesSport("BASKETBALL, WOMEN'S", MB) === false, null);
ok("women's scan accepts BASKETBALL, WOMEN'S", S.namesSport("BASKETBALL, WOMEN'S", WB) === true, null);
ok("women's scan REJECTS BASKETBALL, MEN'S", S.namesSport("BASKETBALL, MEN'S", WB) === false, null);
ok('a bare BASKETBALL section is accepted for men (the default)',
  S.namesSport('BASKETBALL', MB) === true, null);

console.log('-- the sibling is reported as the sibling, not as "no match" --');
ok("women's section blocks a men's scan and names women's",
  S.namesOtherSport("BASKETBALL, WOMEN'S", MB) === WB, S.namesOtherSport("BASKETBALL, WOMEN'S", MB));
ok("men's section blocks a women's scan and names men's",
  S.namesOtherSport("BASKETBALL, MEN'S", WB) === MB, S.namesOtherSport("BASKETBALL, MEN'S", WB));
ok('Lady Vols Basketball blocks a men\'s scan',
  S.namesOtherSport('Lady Vols Basketball', MB) !== null, S.namesOtherSport('Lady Vols Basketball', MB));

console.log('-- cross-sport, both directions --');
ok('football blocks a basketball scan', S.namesOtherSport('Head Football Coach', MB) === FB, null);
ok('basketball blocks a football scan', S.namesOtherSport('Head Basketball Coach', FB) === MB, null);
ok('baseball blocks a basketball scan', S.namesOtherSport('BASEBALL', MB) !== null, S.namesOtherSport('BASEBALL', MB));
ok('a football title on a football scan is fine', S.namesOtherSport('Head Football Coach', FB) === null, null);
ok('a neutral title names no sport', S.namesOtherSport('General Manager', MB) === null, null);
ok('baseball is not confused with basketball',
  S.namesSport('BASEBALL', MB) === false, null);

console.log('-- emails --');
ok('wbb@ blocks a mens scan', S.emailNamesOtherSport('wbb@school.edu', MB) === WB, S.emailNamesOtherSport('wbb@school.edu', MB));
ok('mbb@ blocks a womens scan', S.emailNamesOtherSport('mbb@school.edu', WB) === MB, null);
ok('mbb@ is fine on a mens scan', S.emailNamesOtherSport('mbb@school.edu', MB) === null, null);
ok('football@ blocks a basketball scan', S.emailNamesOtherSport('football@school.edu', MB) === FB, null);
ok('basketball@ blocks a football scan', S.emailNamesOtherSport('basketball@school.edu', FB) === MB, null);
ok('a personal address names nothing', S.emailNamesOtherSport('jsmith@school.edu', MB) === null, null);
ok('patrick@ does not match track', S.emailNamesOtherSport('patrick@school.edu', FB) === null, null);
ok('a bare basketball@ is allowed on a mens scan (default)',
  S.emailNamesOtherSport('basketball@school.edu', MB) === null, null);

console.log('-- URLs --');
ok('a mens-basketball path is scoped for men', S.sportScopedUrl('https://x.com/sports/mens-basketball/coaches', MB), null);
ok('and NOT for women', S.sportScopedUrl('https://x.com/sports/mens-basketball/coaches', WB) === false, null);
ok('a womens-basketball path is scoped for women', S.sportScopedUrl('https://x.com/sports/womens-basketball/coaches', WB), null);
ok('and NOT for men', S.sportScopedUrl('https://x.com/sports/womens-basketball/coaches', MB) === false, null);
ok('a football path is scoped for football', S.sportScopedUrl('https://x.com/sports/football/coaches', FB), null);
ok('a football path is not basketball', S.sportScopedUrl('https://x.com/sports/football/coaches', MB) === false, null);
ok('a department path is scoped to nothing', S.sportScopedUrl('https://x.com/staff-directory', MB) === false, null);
ok('?path=mbball is scoped for men', S.sportScopedUrl('https://x.com/staff-directory?path=mbball', MB), null);

console.log('-- sportContradiction, ordered --');
const c1 = S.sportContradiction({ title: 'Head Coach', section: "BASKETBALL, WOMEN'S", email: null }, MB);
ok('a womens section blocks a mens scan', c1 && c1.kind === 'section', c1);
const c2 = S.sportContradiction({ title: 'Head Coach', section: 'BASKETBALL', email: 'wbb@x.edu' }, MB);
ok('EMAIL wins over a permissive section', c2 && c2.kind === 'email' && c2.sport === WB, c2);
const c3 = S.sportContradiction({ title: 'Head Basketball Coach', section: null, email: null }, MB);
ok('a matching title is not a contradiction', c3 === null, c3);
const c4 = S.sportContradiction({ title: 'Head Football Coach', section: null, email: null }, MB);
ok('a football title on a basketball scan is', c4 && c4.sport === FB, c4);
ok('every contradiction carries its evidence',
  [c1, c2, c4].every((c) => c && typeof c.evidence === 'string'), [c1, c2, c4]);

console.log('-- normalizeSport --');
ok("'basketball' normalizes to mens_basketball", S.normalizeSport('basketball') === MB, S.normalizeSport('basketball'));
ok("'mens-basketball' too", S.normalizeSport('mens-basketball') === MB, null);
ok("'mbb' too", S.normalizeSport('mbb') === MB, null);
ok("'Men's Basketball' spelling", S.normalizeSport('mens basketball') === MB, S.normalizeSport('mens basketball'));
ok("'football' stays football", S.normalizeSport('football') === FB, null);
ok('empty defaults to football', S.normalizeSport('') === FB, null);
ok('undefined defaults to football', S.normalizeSport(undefined) === FB, null);
ok('an unknown sport returns null, not a wrong default', S.normalizeSport('quidditch') === null, S.normalizeSport('quidditch'));
ok("'wbb' normalizes to womens", S.normalizeSport('wbb') === WB, null);

console.log('-- the table --');
ok('football keeps its 13 paths', S.SPORTS.football.paths.length === 13, S.SPORTS.football.paths.length);
ok('basketball has the 8 specified', S.SPORTS[MB].paths.length === 8, S.SPORTS[MB].paths.length);
ok('basketball has NO bare /coaches', !S.SPORTS[MB].paths.includes('/coaches'), null);
ok('basketball has no /basketball/coaches', !S.SPORTS[MB].paths.includes('/basketball/coaches'), null);
ok('football thresholds unchanged',
  S.SPORTS.football.thresholds.minKeyRoles === 3 && S.SPORTS.football.thresholds.minStaff === 5,
  S.SPORTS.football.thresholds);
ok('basketball thresholds are 2 and 3',
  S.SPORTS[MB].thresholds.minKeyRoles === 2 && S.SPORTS[MB].thresholds.minStaff === 3,
  S.SPORTS[MB].thresholds);
ok('basketball roles are the 5 specified',
  S.SPORTS[MB].roles.map((r) => r.key).join(',') === 'general_manager,basketball_ops,player_personnel,head_coach,assistant_coach',
  S.SPORTS[MB].roles.map((r) => r.key));
ok('football verified URLs preserved', Object.keys(S.SPORTS.football.verifiedUrls).length === 5, null);
ok('Alabama lock preserved', S.SPORTS.football.verifiedUrls['Alabama'] === 'https://rolltide.com/sports/football/coaches', null);
ok('womens basketball EXISTS in the table', !!S.SPORTS[WB], null);
ok('but is NOT in the UI list', !S.UI_SPORTS.includes(WB), S.UI_SPORTS);
ok('the UI offers exactly football and mens basketball',
  S.UI_SPORTS.join(',') === 'football,mens_basketball', S.UI_SPORTS);

console.log('-- basketball role matching --');
const bbRoles = S.SPORTS[MB].roles;
const m = (t) => bbRoles.filter((r) => r.match.test(t)).map((r) => r.key);
ok('Head Coach matches head_coach', m('Head Coach').includes('head_coach'), m('Head Coach'));
ok("Head Men's Basketball Coach matches", m("Head Men's Basketball Coach").includes('head_coach'), m("Head Men's Basketball Coach"));
ok('Director of Basketball Operations matches ops', m('Director of Basketball Operations').includes('basketball_ops'), m('Director of Basketball Operations'));
ok('General Manager matches gm', m('General Manager').includes('general_manager'), null);
ok('Assistant Coach matches assistant', m('Assistant Coach').includes('assistant_coach'), null);
ok('Director of Recruiting matches personnel', m('Director of Recruiting').includes('player_personnel'), null);

console.log('-- block-only sports still block, which is why they are kept --');
for (const other of ['BASEBALL', 'SOFTBALL', 'Track and Field', 'Soccer', 'Volleyball',
  'Wrestling', 'Swimming and Diving', 'Gymnastics', 'Golf', 'Tennis']) {
  ok(`${other} blocks a basketball scan`, S.namesOtherSport(other, MB) !== null, S.namesOtherSport(other, MB));
  ok(`${other} blocks a football scan`, S.namesOtherSport(other, FB) !== null, S.namesOtherSport(other, FB));
}
ok('Missouri baseball coach still blocked on a football scan',
  S.sportContradiction({ title: 'Head Coach', section: 'BASEBALL', email: 'baseball@missouri.edu' }, FB) !== null,
  null);
ok('and the reason is the email, as before',
  S.sportContradiction({ title: 'Head Coach', section: 'BASEBALL', email: 'baseball@missouri.edu' }, FB).kind === 'email',
  null);
ok('block-only sports are NOT scannable', !S.SCANNABLE.includes('baseball'), S.SCANNABLE);
ok('only 3 sports are scannable', S.SCANNABLE.length === 3, S.SCANNABLE);
ok('--sport baseball is refused rather than run empty', S.normalizeSport('baseball') === null, S.normalizeSport('baseball'));

console.log('');
console.log('failures: ' + fails);
process.exit(fails ? 1 : 0);
