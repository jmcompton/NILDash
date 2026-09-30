'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js            every suite, against the committed baseline
//   node tests/restricted.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── NO CARD FOR A RESTRICTED BUSINESS, AND NO BLOCK FOR A WORD ─────────────
// Four breweries were open cards on agents' screens for college athletes: the
// compliance gate ran only at send, and the nightly fill never asked. And the
// name matching blocked a barbershop, a roofer and a rec centre for a word.
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const C = require(REPO + 'server/services/compliance.js');
const Q = require(REPO + 'server/services/outreachQueue.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const keys = (n, e) => C.classifyBusiness(n, e || {}).hits.map((h) => h.key);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE BOUNDARY ───────────────────────────────────────────────────────
  OUT.push('-- a word is not a business --');
  const falsePos = ['Gentlemen’s Grooming', "Gentlemen's Grooming", 'Young Guns Roofing', 'Spinnaker Point Adult Recreation Center',
    'Top Gun Car Wash', 'Wine & Design', 'Kindred Spirits Yoga', 'Greyhound Bus Station', 'Hemp Clothing Co', 'Pistol Pete\'s Pizza',
    'Adult Day Health Center', 'Golden Keno Diner', 'Poker Face Tattoo'];
  const wrongly = falsePos.filter((n) => keys(n).length);
  ok(`none of these real businesses is blocked for a word in its name (${falsePos.length})`, wrongly.length === 0, wrongly.map((n) => [n, keys(n)]));
  ok('  each is reported as possible, for a person to look at, and nothing more',
    ['Gentlemen’s Grooming', 'Young Guns Roofing', 'Spinnaker Point Adult Recreation Center'].every((n) => C.classifyBusiness(n).possible.length === 1));
  const breweries = ['Sea Dog Brewing', 'Holy City Brewing', 'Connecticut Valley Brewing', 'Lolo Peak Brewery'];
  ok('the four breweries on agents\' screens are alcohol by name', breweries.every((n) => keys(n)[0] === 'alcohol'), breweries.map((n) => keys(n)));
  const realOnes = [['Scores Gentlemen’s Club', 'adult'], ['Velvet Adult Boutique', 'adult'], ['Tactical Gun Shop', 'firearms'],
    ['Riverside Gun Range', 'firearms'], ['Los Alamitos Race Course', 'gambling'], ['Del Mar Thoroughbred Club', 'gambling'],
    ['Oaks Card Club', 'gambling'], ['Downtown Smoke Shop', 'tobacco'], ['Green Leaf Dispensary', 'cannabis'], ['Total Wine Bar', 'alcohol']];
  const missed = realOnes.filter(([n, k]) => keys(n)[0] !== k);
  ok(`the trade phrases still block on their own (${realOnes.length})`, missed.length === 0, missed.map(([n]) => [n, keys(n)]));
  ok('a weak word is enough when Google says the same thing',
    keys('Joe’s Wine', { types: ['liquor_store'] })[0] === 'alcohol'
    && keys('Young Guns', { primaryTypeDisplayName: 'Gun shop' })[0] === 'firearms'
    && keys('The Gentlemen', { types: ['strip_club'] })[0] === 'adult');
  const CS = read('server/services/compliance.js');
  ok('every category has its weak words separate from its strong ones',
    C.CATEGORIES.filter((c) => c.key !== 'supplements').every((c) => Array.isArray(c.weakMarkers))
    && !C.CATEGORY_BY_KEY.adult.nameMarkers.includes('adult') && !C.CATEGORY_BY_KEY.firearms.nameMarkers.includes('guns')
    && /TWO KINDS OF WORD, and the difference is the whole boundary/.test(CS));

  // ── 2. THE FILL ASKS WHAT THE SEND WOULD SAY ──────────────────────────────
  OUT.push('', '-- the fill refuses what the send would stop --');
  const adult = { over18: true }, minor = { dob: '2011-06-01' }, unknown = {};
  ok('a brewery for an adult athlete: no card (the send would hold it)', (Q.restrictedFor('Sea Dog Brewing', null, adult) || {}).severity === 'hold');
  ok('  for a minor: no card (the send would block it)', (Q.restrictedFor('Sea Dog Brewing', null, minor) || {}).severity === 'block');
  ok('  for an athlete of unknown age: no card', !!Q.restrictedFor('Sea Dog Brewing', null, unknown));
  ok('a casino: no card for anyone', (Q.restrictedFor('Commerce Casino', null, adult) || {}).severity === 'block');
  ok('a bar Google types as one, whatever its name: no card', (Q.restrictedFor('The Local', { types: ['restaurant', 'bar'] }, adult) || {}).key === 'alcohol');
  ok('the roofer, the barbershop and the rec centre ARE cards', ['Young Guns Roofing', 'Gentlemen’s Grooming', 'Spinnaker Point Adult Recreation Center']
    .every((n) => Q.restrictedFor(n, null, unknown) === null));
  ok('a social brand whose NAME says nothing is caught by its recorded category', (Q.restrictedFor('Underdog', { types: [], primaryTypeDisplayName: 'fantasy sports' }, adult) || {}).key === 'gambling'
    && (Q.restrictedFor('Sleeper', { types: [], primaryTypeDisplayName: 'sports betting' }, adult) || {}).key === 'gambling'
    && Q.restrictedFor('Underdog', null, adult) === null);
  ok('supplements stay cards and are held at send for a person, as before', Q.restrictedFor('Vitamin Shoppe Supplements', null, adult) === null
    && C.classifyBusiness('Vitamin Shoppe Supplements').hits[0].key === 'supplements');
  const JOB = read('server/jobs/outreachQueue.js');
  const byName = JOB.indexOf("const rx = Q.restrictedFor(cand.brand_name, cand.category ?");
  const laneSplit = JOB.indexOf('// ── THE LANE DECIDES THE ROUTE');
  const byPlace = JOB.indexOf("Q.restrictedFor(cand.brand_name, place || (cand.category");
  const prescreen = JOB.indexOf('const pre = Q.prescreen(place);');
  ok('the fill checks the name BEFORE the lanes split, so social and national are checked too', byName > 0 && byName < laneSplit, { byName, laneSplit });
  ok('  and again with Google\'s types after the Places lookup, before any money on contacts', byPlace > prescreen && prescreen > 0);
  ok('  a refused business is recorded as rejected with the reason, not as a fault', /result: 'rejected', restricted: rx\.key, reason: 'restricted: ' \+ rx\.why/.test(JOB)
    && !/restricted: rx\.key[^\n]*fault: true/.test(JOB));

  // ── 3. THE AUDIT PULLS THE CARDS ALREADY THERE ────────────────────────────
  OUT.push('', '-- the audit pulls the open cards --');
  const AG = 'rs-agent', ATH = 'rs-ath';
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Restricted Agent', 'rs-agent@x.test', 'x', 'agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ($1, $2, '{"name":"Rs Athlete","over18":true}')`, [ATH, AG]);
  const mk = (slot, brand) => P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state) VALUES ($1,$2,$3,$4,$5,'queued')`,
    [AG, ATH, slot, 'rs-' + slot, brand]);
  await mk(71, 'Holy City Brewing'); await mk(72, 'Young Guns Roofing'); await mk(73, 'Gentlemen’s Grooming');
  const env = { ...process.env, INIT_WAIT_MS: '6000' };
  const dry = execFileSync(process.execPath, [REPO + 'scripts/block-audit.js'], { env, encoding: 'utf8', timeout: 120000 });
  const st = async () => (await P.query(`SELECT brand_name, state, outcome FROM outreach_queue WHERE agent_id = $1 ORDER BY slot`, [AG])).rows;
  ok('report only: the brewery card is listed and nothing changes', /Holy City Brewing for Rs Athlete/.test(dry) && /would be pulled with --apply/.test(dry)
    && (await st()).every((r) => r.state === 'queued'));
  ok('  the roofer and the barbershop are not listed as restricted', !/card \d+: Young Guns Roofing/.test(dry) && !/card \d+: Gentlemen/.test(dry));
  execFileSync(process.execPath, [REPO + 'scripts/block-audit.js', '--apply'], { env, encoding: 'utf8', timeout: 120000 });
  const after = await st();
  ok('--apply pulls the brewery card: retired, outcome restricted, slot free', after[0].state === 'retired' && after[0].outcome === 'restricted', after);
  ok('  and leaves the other two on the agent\'s screen', after[1].state === 'queued' && after[2].state === 'queued', after);
  ok('the admin runner has block-audit', /'block-audit': \{ file: 'scripts\/block-audit\.js'/.test(read('server/index.js')));
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE id = $1`, [ATH]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
