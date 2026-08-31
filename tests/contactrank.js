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
// THE NON-DETERMINISM, PINNED. Every case here is a real one from the three
// Birmingham runs. The headline assertion is the one the whole change exists
// for: shuffle the inputs any way you like and the same person wins.
const ROOT = REPO;
const CR = require(ROOT + 'server/services/contactRank.js');
const GG = require(ROOT + 'server/services/greetingGuard.js');

let F = 0;
const ok = (n, c, g) => { if (c) console.log('  PASS ' + n); else { F++; console.log('  FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };

// ── 1. THE TITLE IS THE TELL ───────────────────────────────────────────────
console.log('\n-- 1. a title containing "owner" is not automatically an owner --');
const R = CR.RANK;
ok('"Owner" is the owner', CR.authorityOf('Owner').rank === R.OWNER);
ok('"Co-Owner" is too', CR.authorityOf('Co-Owner').rank === R.OWNER);
ok('"Building owner (per news)" is NOT — that is a landlord',
  CR.authorityOf('Building owner (per news)').rank === R.PLACEHOLDER,
  CR.authorityOf('Building owner (per news)'));
ok('  and it says why', /owns the building/.test(CR.authorityOf('Building owner (per news)').why));
ok('"Property owner" is not either', CR.authorityOf('Property owner').rank === R.PLACEHOLDER);
ok('"Former owner" is not either', CR.authorityOf('Former owner').rank === R.PLACEHOLDER);
ok('"Company contact (not confirmed owner)" is NOT — the title says so itself',
  CR.authorityOf('Company contact (not confirmed owner)').rank === R.PLACEHOLDER,
  CR.authorityOf('Company contact (not confirmed owner)'));
ok('a real owner still outranks all of them',
  CR.authorityOf('Owner').rank < CR.authorityOf('Building owner').rank);
ok('registered agent is still last', CR.authorityOf('Registered Agent (state filing)').rank === R.REGISTERED_AGENT);
// "Franchise Owner" hits the owner rule before the franchise rule and lands at 0
// rather than 1. That is the pre-existing behaviour and it is right: a franchise
// owner can approve a local deal, and 0 and 1 are both Tier 1. What matters is
// that the disqualifier pass does not sweep it up with the landlords.
ok('a franchisee is Tier 1, not a placeholder',
  [R.OWNER, R.FRANCHISEE].indexOf(CR.authorityOf('Franchise Owner').rank) !== -1,
  CR.authorityOf('Franchise Owner'));
ok('  and a bare "Franchisee" is too',
  [R.OWNER, R.FRANCHISEE].indexOf(CR.authorityOf('Franchisee').rank) !== -1,
  CR.authorityOf('Franchisee'));

// ── 2. HEDGING ─────────────────────────────────────────────────────────────
console.log('\n-- 2. how strongly the title claims it --');
ok('a plain title is unhedged', CR.hedgeOf('Owner') === CR.HEDGE.NONE);
ok('"(per news)" is the weakest', CR.hedgeOf('Owner (per news)') === CR.HEDGE.NEWS);
ok('"(state filing)" sits between', CR.hedgeOf('Member (state filing)') === CR.HEDGE.FILING);
ok('an unhedged owner beats a hedged one',
  CR.compareContacts({ name: 'A', title: 'Owner', source: 'site' },
    { name: 'B', title: 'Owner (per news)', source: 'news' }) < 0);

// ── 3. THE HEADLINE: ORDER IN, SAME ANSWER OUT ─────────────────────────────
console.log('\n-- 3. Continental Bakery, every arrival order --');
const CONTINENTAL = [
  { name: 'Carole Griffin', title: 'Owner', source: 'site', sources: ['site'] },
  { name: 'David Griner', title: 'Owner (per news)', source: 'news', sources: ['news'] },
  { name: 'Carole', title: null, source: 'chamber', sources: ['chamber'] },
];
// Every permutation of three.
const perms = (a) => (a.length <= 1 ? [a]
  : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map((p) => [x].concat(p))));
const winners = new Set();
for (const p of perms(CONTINENTAL)) winners.add(CR.rankContacts(p)[0].name);
ok('all 6 orderings pick the SAME person', winners.size === 1, [...winners]);
ok('  and it is the one from the business\'s own site',
  [...winners][0] === 'Carole Griffin', [...winners]);
ok('  the Adweek editor never wins', !winners.has('David Griner'));

console.log('\n-- 3b. Homewood Cycle: a landlord must never be the addressee --');
const HOMEWOOD = [
  { name: 'Walter Busenlehner', title: 'Building owner (per news)', source: 'news', sources: ['news'] },
  { name: 'Mandy', title: null, source: 'chamber', sources: ['chamber'] },
];
const hw = new Set();
for (const p of perms(HOMEWOOD)) hw.add(CR.rankContacts(p)[0].name);
ok('both orderings agree', hw.size === 1, [...hw]);
ok('  and the landlord loses to an untitled name', [...hw][0] === 'Mandy', [...hw]);

// ── 4. CORROBORATION ───────────────────────────────────────────────────────
console.log('\n-- 4. two sources agreeing beats one --');
const twoSrc = { name: 'Forrest Walden', title: 'Owner', source: 'chamber', sources: ['chamber', 'facebook'] };
const oneSrc = { name: 'Jenny Auvil', title: 'Owner', source: 'chamber', sources: ['chamber'] };
ok('corroboration is counted', CR.corroborationOf(twoSrc) === 2);
ok('  duplicates in the list do not inflate it',
  CR.corroborationOf({ sources: ['site', 'site', 'chamber'] }) === 2);
ok('the corroborated owner wins', CR.rankContacts([oneSrc, twoSrc])[0].name === 'Forrest Walden');
ok('  in either order', CR.rankContacts([twoSrc, oneSrc])[0].name === 'Forrest Walden');
ok('but authority still comes first — a corroborated MANAGER loses to a single-source OWNER',
  CR.rankContacts([
    { name: 'Mgr', title: 'General Manager', sources: ['site', 'facebook', 'maps'] },
    { name: 'Own', title: 'Owner', sources: ['site'] },
  ])[0].name === 'Own');

// ── 5. UNCONFIRMED ─────────────────────────────────────────────────────────
console.log('\n-- 5. what we will not put in a greeting --');
ok('one third-party source is unconfirmed',
  CR.isUnconfirmed({ name: 'X', title: 'Owner', source: 'news', sources: ['news'] }));
ok('two sources is confirmed',
  !CR.isUnconfirmed({ name: 'X', title: 'Owner', source: 'news', sources: ['news', 'chamber'] }));
ok('the business\'s OWN SITE alone is enough — it is the authority on itself',
  !CR.isUnconfirmed({ name: 'X', title: 'Owner', source: 'site', sources: ['site'] }));
ok('  but only with a real role title',
  CR.isUnconfirmed({ name: 'X', title: null, source: 'site', sources: ['site'] }));
ok('  and not when hedged', CR.isUnconfirmed({ name: 'X', title: 'Owner (per news)', source: 'site', sources: ['site'] }));
ok('a landlord is always unconfirmed',
  CR.isUnconfirmed({ name: 'X', title: 'Building owner', source: 'site', sources: ['site', 'news'] }));

console.log('\n-- 5b. the greeting guard reads it --');
const greetable = (c) => GG.greetableContacts([c]).length === 1;
ok('an unconfirmed contact is NOT greeted by first name',
  !greetable({ name: 'David Griner', title: 'Owner', email: 'd@x.com', emailKind: 'published',
    source: 'news', sources: ['news'], unconfirmed: true }));
ok('a corroborated one IS',
  greetable({ name: 'Forrest Walden', title: 'Owner', email: 'f@x.com', emailKind: 'published',
    source: 'chamber', sources: ['chamber', 'facebook'], unconfirmed: false }));
ok('a legacy row with no flag is judged by the same rule, not waved through',
  !greetable({ name: 'Legacy', title: 'Owner', email: 'l@x.com', emailKind: 'published',
    source: 'news', sources: ['news'] }));

// ── 6. TOTAL ORDER ─────────────────────────────────────────────────────────
console.log('\n-- 6. the comparator is a total order --');
const SAMPLE = [
  { name: 'Alpha', title: 'Owner', source: 'site', sources: ['site'] },
  { name: 'Bravo', title: 'Owner', source: 'site', sources: ['site'] },
  { name: 'Charlie', title: 'General Manager', source: 'maps', sources: ['maps'] },
  { name: 'Delta', title: 'Building owner', source: 'news', sources: ['news'] },
  { name: 'Echo', title: null, source: 'chamber', sources: ['chamber'] },
];
ok('two DIFFERENT people never compare equal',
  SAMPLE.every((a) => SAMPLE.every((b) => (a === b) || CR.compareContacts(a, b) !== 0)));
// Shuffle deterministically (no Math.random, so a failure reproduces).
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const first = CR.rankContacts(SAMPLE).map((c) => c.name).join(',');
let stable = true;
for (let i = 0; i < 200; i++) {
  const sh = SAMPLE.slice().sort(() => rnd() - 0.5);
  if (CR.rankContacts(sh).map((c) => c.name).join(',') !== first) { stable = false; break; }
}
ok('200 shuffles produce the identical ordering', stable, first);
ok('  Alpha before Bravo, decided by name and not by arrival', /^Alpha,Bravo/.test(first), first);

// ── 7. TEMPERATURE AND THE CACHE VERSION ───────────────────────────────────
console.log('\n-- 7. the two settings --');
const AI = require('fs').readFileSync(ROOT + 'server/ai.js', 'utf8');
const fanout = AI.slice(AI.indexOf('async function _contactWebSearchRaw'),
  AI.indexOf('async function _contactWebSearchRaw') + 900);
ok('the contact extraction call pins temperature to 0', /temperature:\s*0\b/.test(fanout), null);
// The point is that v5 rows -- written by the old comparator -- can never be
// served again. Pinning the literal made this fail on every later bump and say
// the ranking fix had regressed, which is not what it tests.
ok('the contacts cache version is past the bad rows',
  parseInt((AI.match(/_CONTACTS_CACHE_VERSION = (\d+)/) || [])[1], 10) >= 6,
  (AI.match(/_CONTACTS_CACHE_VERSION = \d+/) || [])[0]);

// ── 8. THE SCRIPTS ─────────────────────────────────────────────────────────
console.log('\n-- 8. a run cannot silently go live --');
const LS = require('fs').readFileSync(ROOT + 'scripts/ladder-sample.js', 'utf8');
ok('ladder-sample refuses with no DATABASE_URL', /DATABASE_URL is not set/.test(LS));
ok('  and exits non-zero', /process\.exit\(2\)/.test(LS.slice(LS.indexOf('DATABASE_URL is not set'))));
ok('  with an explicit opt-out that is reachable',
  LS.indexOf('const _noCache') < LS.indexOf('DATABASE_URL is not set')
  && /!_noCache && !process\.env\.DATABASE_URL/.test(LS));
const LT = require('fs').readFileSync(ROOT + 'scripts/line-type.js', 'utf8');
ok('the numverify key is trimmed', /NUMVERIFY_API_KEY \|\| ''\)\.trim\(\)/.test(LT));

console.log('\nfailures: ' + F);
process.exit(F ? 1 : 0);
