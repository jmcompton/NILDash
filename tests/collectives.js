'use strict';
// Runs against the local test Postgres.
//
//   node tests/run.js             every suite, against the committed baseline
//   node tests/collectives.js     just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A COLLECTIVE IS NEVER A SPONSOR PROSPECT ───────────────────────────────
// Collectives were live cards for Marcus Johnson and Messiah Mickens. A
// collective pays athletes; it does not sponsor them.
const fs = require('fs');
const { execFileSync } = require('child_process');
const store = require(REPO + 'server/store.js');
const COL = require(REPO + 'server/services/collectives.js');
const C = require(REPO + 'server/services/compliance.js');
const Q = require(REPO + 'server/services/outreachQueue.js');
const TeamScan = require(REPO + 'server/services/teamScan.js');
const Scout = require(REPO + 'server/services/scout.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 600) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');
const isCol = (n, e) => !!COL.detect(n, e);

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;

  // ── 1. THE DETECTOR ───────────────────────────────────────────────────────
  OUT.push('-- what a collective looks like --');
  const named = ['Yea Alabama', 'Texas One Fund', 'Champions Circle', '1870 Society', 'Cohesion Foundation', 'Grove Collective',
    'The Battle’s End', 'Happy Valley United', 'Volunteer Club', 'Spyre Sports', 'Classic City Collective'];
  ok(`every named collective in the seed list is caught, with no category (${named.length})`, named.every((n) => isCol(n)), named.filter((n) => !isCol(n)));
  ok('  the list lives in one data file, so adding one is one line', JSON.parse(read('server/data/nilCollectives.json')).names.includes('Yea Alabama'));
  // .gitignore excludes data/ folders; untracked, the file never deploys and
  // production silently runs without the named list.
  let tracked = false;
  try { execFileSync('git', ['ls-files', '--error-unmatch', 'server/data/nilCollectives.json'], { cwd: REPO, stdio: 'ignore' }); tracked = true; } catch (_) {}
  ok('  and that file is tracked by git, so it actually deploys', tracked);
  const phrases = ['Hokie NIL Fund', 'Buckeye NIL Collective', 'Student Athlete Fund of Iowa', 'Players Fund Inc', 'Tiger Athlete Fund'];
  ok('the phrases only a collective uses are caught', phrases.every((n) => isCol(n)), phrases.filter((n) => !isCol(n)));
  ok('"collective" with a nonprofit, sports-org or missing category is a collective',
    isCol('Warrior Collective', { primaryTypeDisplayName: 'Non-profit organization' }) && isCol('Warrior Collective', {})
    && isCol('Crimson Collective', { category: 'sports club' }));
  ok('A NONPROFIT TIED TO A SCHOOL OR TEAM, without the word, is one too', isCol('Tiger Athletics Foundation', { primaryTypeDisplayName: 'Non-profit organization' }));
  const keep = [['Coffee Collective', { types: ['cafe'], primaryType: 'coffee_shop' }], ['The Hair Collective', { primaryType: 'hair_salon' }],
    ['Hair Collective', { category: 'salon' }], ['Iron Collective Gym', { types: ['gym'] }], ['Artisan Collective', { types: ['clothing_store'] }],
    ['Taco Collective', { category: 'restaurant' }], ['Volunteer Club Bar & Grill', { types: ['restaurant', 'bar'] }], ['Chuze Fitness', { types: ['gym'] }]];
  ok(`real local businesses named "collective" are KEPT when Google says what they are (${keep.length})`, keep.every(([n, e]) => !isCol(n, e)),
    keep.filter(([n, e]) => isCol(n, e)).map(([n]) => n));

  // ── 2. THE EXISTING ENGINE, NOT A NEW ONE ─────────────────────────────────
  OUT.push('', '-- one engine: compliance --');
  ok('compliance.classifyBusiness reports it as the collective category', C.classifyBusiness('Yea Alabama', {}).hits[0].key === 'collective');
  ok('  blocked at every age, so the send gate stops it too', C.severityFor('collective', C.ageFrom('2000-01-01')) === 'block' && C.severityFor('collective', C.ageFrom(null)) === 'block');
  ok('the nightly card gate refuses it', (Q.restrictedFor('Happy Valley United', null, { over18: true }) || {}).key === 'collective');
  ok('  and a Coffee Collective with its category is a card', Q.restrictedFor('Coffee Collective', { types: [], primaryTypeDisplayName: 'coffee' }, { over18: true }) === null);
  ok('  "collective" with no category yet waits for the Places lookup, then is refused if still none',
    Q.restrictedFor('Blue Collective', null, { over18: true }, undefined, { defer: true }) === null
    && (Q.restrictedFor('Blue Collective', null, { over18: true }) || {}).key === 'collective');
  const JOB = read('server/jobs/outreachQueue.js');
  ok('  the fill defers at the name check and decides after Places, even when Places found nothing',
    /ctx\.athleteRow, undefined, \{ defer: true \}\)/.test(JOB) && /Q\.restrictedFor\(cand\.brand_name, place \|\| \(cand\.category/.test(JOB));
  ok('the team scan blocks it (university side, same rule)', (TeamScan.blockedFor({ name: 'Classic City Collective', types: [] }) || {}).key === 'collective'
    && TeamScan.BLOCKED_KEYS.includes('collective'));

  // ── 3. DISCOVERY: A COLLECTIVE NEVER ENTERS A POOL ────────────────────────
  OUT.push('', '-- discovery --');
  ok('the Places market build drops it', /require\('\.\/collectives'\)\.detect\(r\.name/.test(read('server/services/placesMarket.js')) && /collective=\$\{dropCollective\}/.test(read('server/services/placesMarket.js')));
  ok('Deal Scan\'s addCandidate drops it (scan results, pool and cards)', /require\('\.\/services\/collectives'\)\.detect\(nm/.test(read('server/ai.js')));
  const MK = 'colltest-town, zz';
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [MK]);
  const rec = await store.recordMarketPool([{ name: 'Yea Alabama', market: 'school' }, { name: 'Coffee Collective', category: 'coffee', market: 'school' },
    { name: 'Crimson NIL Fund', market: 'school' }], { schoolMarket: 'Colltest-town, ZZ' });
  const pooled = (await P.query(`SELECT brand FROM market_business_seen WHERE market_key = $1 ORDER BY brand`, [rec.schoolKey])).rows.map((r) => r.brand);
  ok('the pool write itself refuses collectives, whoever calls it', JSON.stringify(pooled) === '["Coffee Collective"]', pooled);
  await P.query(`DELETE FROM market_business_seen WHERE market_key = $1`, [rec.schoolKey]);
  const natStore = { getTopNilComps: async () => [{ brand: 'Yea Alabama', count: 9 }, { brand: 'Nike', count: 4 }, { brand: 'Texas One Fund', count: 7 }] };
  const Nat = await Scout.assembleSlate(P, { agentId: 'col-ag', athlete: { id: 'col-canary', school: 'X', hasLocalMarket: false, marketKey: null }, store: natStore, limit: 5 });
  const natNames = (Nat.picks || []).map((p) => p.brand_name);
  ok('the national lane (deal_comps, "mostly collectives") drops them before the slate', !natNames.includes('Yea Alabama') && !natNames.includes('Texas One Fund'), natNames);

  // ── 4. THE PURGE, ON A FIXTURE LIKE THIS MORNING ──────────────────────────
  OUT.push('', '-- block-audit: report, then apply --');
  const AG = 'col-agent';
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
  await P.query(`INSERT INTO users (id, name, email, password, role) VALUES ($1, 'Collective Agent', 'col-agent@x.test', 'x', 'agent')`, [AG]);
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('col-marcus', $1, '{"name":"Marcus Johnson","over18":true}'), ('col-messiah', $1, '{"name":"Messiah Mickens","over18":true}')`, [AG]);
  const card = (ath, slot, brand) => P.query(`INSERT INTO outreach_queue (agent_id, athlete_id, slot, brand_key, brand_name, state, lane) VALUES ($1,$2,$3,$4,$5,'queued','national')`,
    [AG, ath, slot, 'col-' + slot, brand]);
  await card('col-marcus', 81, 'Yea Alabama'); await card('col-marcus', 82, 'Chuze Fitness');
  await card('col-messiah', 83, 'Happy Valley United'); await card('col-messiah', 84, 'Coffee Collective');
  await P.query(`INSERT INTO market_business_seen (market_key, brand, category) VALUES ($1, 'Coffee Collective', 'coffee'), ($1, 'Grove Collective', NULL), ($1, 'Spyre Sports', NULL)
    ON CONFLICT DO NOTHING`, ['colaudit, zz']);
  // The university side: a team, a pool row and a waiting ask to a collective.
  await P.query(`INSERT INTO university_teams (id, university_id, name, sport, market_key) VALUES ('colu:mbb', 'univ-cypress', 'Col MBB', 'Basketball', 'colu, zz') ON CONFLICT (id) DO NOTHING`);
  await P.query(`INSERT INTO university_market_seen (market_key, brand, category, types) VALUES ('colu, zz', 'Classic City Collective', NULL, '[]'), ('colu, zz', 'Coffee Collective', 'coffee', '["cafe"]') ON CONFLICT DO NOTHING`);
  await P.query(`INSERT INTO university_drafts (id, university_id, team_id, brand_key, brand_name, inventory_id, inventory_name, price_cents, subject, body)
    VALUES ('udraft_colu', 'univ-cypress', 'colu:mbb', 'k', 'Classic City Collective', 'i', 'Courtside banner', 150000, 's', 'b') ON CONFLICT DO NOTHING`);
  const env = { ...process.env, INIT_WAIT_MS: '6000' };
  const dry = execFileSync(process.execPath, [REPO + 'scripts/block-audit.js'], { env, encoding: 'utf8', timeout: 120000 });
  const cardState = async () => Object.fromEntries((await P.query(`SELECT brand_name, state FROM outreach_queue WHERE agent_id = $1`, [AG])).rows.map((r) => [r.brand_name, r.state]));
  ok('report only: names the collective card for each athlete', /Marcus Johnson \(col-agent@x\.test\): Yea Alabama/.test(dry) && /Messiah Mickens \(col-agent@x\.test\): Happy Valley United/.test(dry), dry.split('\n').filter((l) => /collective|Marcus|Messiah/i.test(l)));
  ok('  counts the pool rows', /2 collective row\(s\) would be removed from the agent market pools/.test(dry));
  ok('  the COLLECTIVES line gives the totals', /COLLECTIVES: \d+ agent-pool row\(s\), \d+ open agent card\(s\)/.test(dry));
  ok('  and changes nothing', Object.values(await cardState()).every((s) => s === 'queued')
    && (await P.query(`SELECT COUNT(*)::int n FROM market_business_seen WHERE market_key = 'colaudit, zz'`)).rows[0].n === 3);
  ok('  the Coffee Collective card (pool says coffee) is not listed', !/card \d+: Coffee Collective/.test(dry));
  execFileSync(process.execPath, [REPO + 'scripts/block-audit.js', '--apply'], { env, encoding: 'utf8', timeout: 120000 });
  const st = await cardState();
  ok('--apply pulls both collective cards', st['Yea Alabama'] === 'retired' && st['Happy Valley United'] === 'retired', st);
  ok('  and leaves the real businesses on the athletes\' screens', st['Chuze Fitness'] === 'queued' && st['Coffee Collective'] === 'queued', st);
  const ud = (await P.query(`SELECT status FROM university_drafts WHERE id = 'udraft_colu'`)).rows[0];
  const um = Object.fromEntries((await P.query(`SELECT brand, blocked_reason FROM university_market_seen WHERE market_key = 'colu, zz'`)).rows.map((r) => [r.brand, r.blocked_reason]));
  ok('UNIVERSITY: the waiting ask to the collective is withdrawn', ud && ud.status === 'rejected', ud);
  ok('  and the collective is marked blocked in the university pool, the Coffee Collective is not', /^collective:/.test(um['Classic City Collective'] || '') && !um['Coffee Collective'], um);
  const left = (await P.query(`SELECT brand FROM market_business_seen WHERE market_key = 'colaudit, zz' ORDER BY brand`)).rows.map((r) => r.brand);
  ok('  removes the collective pool rows and keeps the Coffee Collective', JSON.stringify(left) === '["Coffee Collective"]', left);

  await P.query(`DELETE FROM market_business_seen WHERE market_key = 'colaudit, zz'`);
  await P.query(`DELETE FROM university_drafts WHERE id = 'udraft_colu'`);
  await P.query(`DELETE FROM university_market_seen WHERE market_key = 'colu, zz'`);
  await P.query(`DELETE FROM university_teams WHERE id = 'colu:mbb'`);
  await P.query(`DELETE FROM outreach_queue WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
  await P.query(`DELETE FROM users WHERE id = $1`, [AG]);
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass} passed\nfailures: ${F}`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
