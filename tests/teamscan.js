'use strict';
// Runs against the local test Postgres. No network: Places and the model are
// replaced with fixtures.
//
//   node tests/run.js           every suite, against the committed baseline
//   node tests/teamscan.js      just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;

// ── A TEAM'S SPONSOR SCAN (services/teamScan, scout's team subject) ─────────
const fs = require('fs');
const store = require(REPO + 'server/store.js');
const Scout = require(REPO + 'server/services/scout.js');
const TeamScan = require(REPO + 'server/services/teamScan.js');
const TW = require(REPO + 'server/services/teamWriter.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 500) : '')); } };
const read = (p) => fs.readFileSync(REPO + p, 'utf8');

// Every agent-side table a team scan must never read or write. The university
// copies carry a university_ prefix, so each name is matched only when it is
// not part of a longer identifier.
const AGENT_TABLES = ['brand_engagement', 'outreach_queue', 'deal_comps', 'athletes', 'card_skips', 'deals',
  'deal_outcomes', 'market_business_seen', 'social_brands', 'outreach_logs', 'research_claims', 'users'];
// SQL comments are stripped first: a comment explaining why a table is not
// read is not a read of it.
const namesTable = (sql, t) => new RegExp(`(^|[^a-z0-9_])${t}([^a-z0-9_]|$)`, 'i').test(String(sql).replace(/--[^\n]*/g, ''));

// A pool that records every statement it is handed.
function recording(P) {
  const seen = [];
  return { seen, query: (sql, params) => { seen.push(typeof sql === 'string' ? sql : sql.text); return P.query(sql, params); } };
}

const CAMPUS = { lat: 33.8285, lng: -118.0247 };
const place = (name, extra) => ({ name, place_id: 'tsp-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), types: [],
  category: 'restaurant', address: '1 Main St, Cypress', lat: 33.83, lng: -118.03, rating: 4.6, user_ratings_total: 320,
  chain: false, market: 'school', ...extra });
const FIXTURE = [
  place('Valley View Tacos'),
  place('Cypress Auto Mall Toyota', { category: 'dealership', types: ['car_dealer'], user_ratings_total: 1400, lat: 33.84 }),
  place('Ironside Fitness', { category: 'gym', types: ['gym'] }),
  place('Bean Scene Coffee', { category: 'coffee', types: ['cafe'], user_ratings_total: 90 }),
  place('Lincoln Avenue Physical Therapy', { category: 'wellness', types: ['physiotherapist'] }),
  place('Agent Only Pizza'),
  // The seven blocked categories, each one way it can arrive.
  place('Cypress Brewing Company', { types: ['brewery'] }),
  place('Harbor Smoke Shop', { category: 'retail' }),
  place('Green Leaf Dispensary', { category: 'retail' }),
  place('Orange County Gun Range', { category: 'retail' }),
  place('Lucky Sportsbook Lounge', { category: 'retail' }),
  place('Speedy Payday Loans', { category: 'retail' }),
  place('Velvet Adult Boutique', { category: 'retail' }),
  place('The Corner Bar & Grill', { types: ['bar', 'restaurant'] }),
];
const fakePlaces = (list) => ({ buildMarketPoolFromPlaces: async () => ({ ok: true, candidates: list, placesCalls: 3, geocoded: CAMPUS }) });

// A model that writes a valid ask from whatever item the prompt names.
function fakeAi(opts = {}) {
  const calls = [];
  return { calls, oneShot: async (prompt, system, max, model) => {
    calls.push({ prompt, system, model });
    const item = (prompt.match(/naming the item exactly as "([^"]+)"/) || [])[1];
    const price = (prompt.match(/the price exactly as "([^"]+)"/) || [])[1];
    if (opts.firstBad && calls.length === 1) return `SUBJECT: Hello\nBODY:\nOur point guard Jaylen Brooks would love to meet you about the ${item} for ${price}.`;
    return `SUBJECT: A home-court partnership\nBODY:\nYou are a few minutes from our gym and the program would be glad to have you with us this winter. We would like to offer the ${item} for ${price}, which supports the season, travel and equipment for the whole team. Would you have ten minutes for a call next week?`;
  } };
}

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  const P = store.pool;
  await TeamScan.ensureTables(P);
  await require(REPO + 'scripts/seed-cypress.js').seed(P);
  const TEAM = 'univ-cypress:mbb';
  const clean = async () => {
    for (const t of ['university_drafts', 'university_outreach_queue', 'university_brand_engagement', 'university_research_claims'])
      await P.query(`DELETE FROM ${t} WHERE team_id = $1`, [TEAM]).catch(() => {});
    await P.query(`DELETE FROM university_market_seen WHERE brand = ANY($1)`, [FIXTURE.map((f) => f.name)]).catch(() => {});
    await P.query(`DELETE FROM market_business_seen WHERE brand = 'Agent Only Pizza'`).catch(() => {});
    await P.query(`DELETE FROM brand_engagement WHERE athlete_id = 'ts-canary'`).catch(() => {});
  };
  await clean();

  // ── 1. MIGRATION 014 ──────────────────────────────────────────────────────
  OUT.push('-- migration 014 --');
  const MIG = read('server/migrations/014_university_sponsor_scan.sql');
  const stmts = MIG.replace(/--[^\n]*/g, '').split(';').map((s) => s.trim()).filter(Boolean);
  // Adding a column to a university table is as safe to repeat as a CREATE.
  const ADD_COL = /^ALTER TABLE university_[a-z_]+ ADD COLUMN IF NOT EXISTS /i;
  ok('every statement is CREATE ... IF NOT EXISTS, or ADD COLUMN IF NOT EXISTS on a university table',
    stmts.every((s) => /^CREATE (TABLE|INDEX) IF NOT EXISTS /i.test(s) || ADD_COL.test(s)), stmts.map((s) => s.slice(0, 50)));
  let twice = true;
  try { await TeamScan.ensureTables(P); await TeamScan.ensureTables(P); } catch (e) { twice = false; OUT.push('  ' + e.message); }
  ok('  and it runs twice without an error', twice);
  const MIGsql = MIG.replace(/--[^\n]*/g, '');
  ok('  it names no agent table and alters only university tables, only by adding columns',
    stmts.filter((s) => /ALTER/i.test(s)).every((s) => ADD_COL.test(s)) && AGENT_TABLES.filter((t) => t !== 'users').every((t) => !namesTable(MIGsql, t)),
    AGENT_TABLES.filter((t) => namesTable(MIGsql, t)));

  // ── 2. THE SUBJECT ────────────────────────────────────────────────────────
  OUT.push('', '-- the subject --');
  const team = (await P.query(`SELECT * FROM university_teams WHERE id = $1`, [TEAM])).rows[0];
  const uni = (await P.query(`SELECT * FROM universities WHERE id = 'univ-cypress'`)).rows[0];
  const ts = Scout.teamSubject({ team, university: uni, marketKey: 'cypress, ca' });
  const T = Scout.tablesOf(ts);
  ok('a team reads university tables', T.engagement === 'university_brand_engagement' && T.queue === 'university_outreach_queue'
    && T.pool === 'university_market_seen' && T.key === 'team_id', T);
  ok('  with sponsor signals, brand flags and skips HARD OFF, local lane only',
    ts.sponsorSignals === false && ts.brandFlags === false && ts.skipSignals === false && ts.lanes.social === false && ts.lanes.national === false && ts.agentId === null);
  ok('  and the subject is frozen', Object.isFrozen(ts) && Object.isFrozen(ts.lanes));
  const forged = { ...ts, tables: { engagement: 'brand_engagement' }, engagement: 'brand_engagement' };
  ok('table names come from scout, never the caller', Scout.tablesOf(forged).engagement === 'university_brand_engagement');
  let threw = false; try { Scout.tablesOf({ subjectKind: 'brand_engagement' }); } catch (_) { threw = true; }
  ok('  an unknown subject kind throws instead of guessing', threw);
  ok('an athlete with no subject is exactly the agent path', Scout.tablesOf({ id: 'x' }).engagement === 'brand_engagement'
    && Scout.athleteSubject({ id: 'x' }, 'ag').sponsorSignals === true);

  // ── 3. BLOCKED CATEGORIES ─────────────────────────────────────────────────
  OUT.push('', '-- blocked categories --');
  const blocks = FIXTURE.map((f) => [f.name, TeamScan.blockedFor(f)]);
  const shouldBlock = ['Cypress Brewing Company', 'Harbor Smoke Shop', 'Green Leaf Dispensary', 'Orange County Gun Range',
    'Lucky Sportsbook Lounge', 'Speedy Payday Loans', 'Velvet Adult Boutique', 'The Corner Bar & Grill'];
  const got = Object.fromEntries(blocks.map(([n, b]) => [n, b && b.key]));
  ok('alcohol, tobacco, cannabis, firearms, gambling, payday lending and adult are blocked',
    got['Cypress Brewing Company'] === 'alcohol' && got['Harbor Smoke Shop'] === 'tobacco' && got['Green Leaf Dispensary'] === 'cannabis'
    && got['Orange County Gun Range'] === 'firearms' && got['Lucky Sportsbook Lounge'] === 'gambling'
    && got['Speedy Payday Loans'] === 'payday lending' && got['Velvet Adult Boutique'] === 'adult', got);
  ok('  a bar typed by Places is alcohol even when the name says grill', got['The Corner Bar & Grill'] === 'alcohol');
  ok('  and the rest are not blocked', blocks.filter(([n]) => !shouldBlock.includes(n)).every(([, b]) => !b), blocks.filter(([n, b]) => !shouldBlock.includes(n) && b));

  // ── 4. FIT AND THE ITEM ───────────────────────────────────────────────────
  OUT.push('', '-- fit and the ask --');
  const near = TeamScan.fitFor({ category: 'dealership', distance_m: 900, user_ratings_total: 800, rating: 4.7 });
  const far = TeamScan.fitFor({ category: 'salon', distance_m: 9000, user_ratings_total: 12, rating: 3.9, chain: true });
  ok('fit is itemised, rewards a close, established dealer and marks down a far chain salon',
    near.fit > far.fit && near.reasons.length >= 4 && far.reasons.some((r) => /chain -12/.test(r)), [near, far]);
  const items = [
    { id: 'a', team_id: 't', name: 'Scorer\'s table front', price_cents: 60000, status: 'available' },
    { id: 'b', team_id: 't', name: 'Season presenting sponsor', price_cents: 150000, status: 'available' },
    { id: 'c', team_id: 't', name: 'Game night', price_cents: 90000, status: 'available' },
    { id: 'd', team_id: 't', name: 'Sold thing', price_cents: 999999, status: 'sold' },
    { id: 'e', team_id: null, name: 'Department banner', price_cents: 300000, status: 'available' },
  ];
  ok('a dealership is asked for the biggest team item, a coffee shop the smallest, a gym the middle',
    TeamScan.pickItem('dealership', items, new Set()).id === 'b' && TeamScan.pickItem('coffee', items, new Set()).id === 'a'
    && TeamScan.pickItem('gym', items, new Set()).id === 'c');
  ok('  sold items and department items are not asked for while the team has its own',
    !['d', 'e'].includes(TeamScan.pickItem('dealership', items, new Set()).id));
  ok('  a department item is asked for when the team has none', TeamScan.pickItem('gym', [items[4]], new Set()).id === 'e');
  ok('  and the run spreads its asks', TeamScan.pickItem('dealership', items, new Set(['b'])).id !== 'b');

  // ── 5. THE WRITER'S VOICE ─────────────────────────────────────────────────
  OUT.push('', '-- the athletics department voice --');
  const wctx = { university: uni, team, business: { brand_name: 'Ironside Fitness', category: 'gym' }, item: items[1] };
  const good = { subject: 'x', body: 'We would like to offer the Season presenting sponsor for $1,500. It supports the program.' };
  ok('a good ask passes the lint', TW.checkAsk(good, wctx).ok);
  const bad = (body) => TW.checkAsk({ subject: 'x', body }, wctx);
  ok('refused: no item named', !bad('Sponsor us for $1,500.').ok);
  ok('refused: the wrong price or a second price', !bad('The Season presenting sponsor for $1,200.').ok
    && !bad('The Season presenting sponsor for $1,500, or the banner for $600.').ok);
  ok('refused: NIL or endorsement language', !bad('An NIL deal: the Season presenting sponsor for $1,500.').ok);
  ok('refused: a student athlete named or identified', !bad('Our point guard Jaylen Brooks and the Season presenting sponsor for $1,500.').ok
    && !bad('Watch #23 play. The Season presenting sponsor for $1,500.').ok);
  ok('refused: a greeting (it is composed, never invented)', !bad('Hi Maria, the Season presenting sponsor for $1,500.').ok);
  const f1 = fakeAi({ firstBad: true });
  const w = await TW.writeAsk(wctx, { ai: f1 });
  ok('a refused draft is rewritten once, on claude-sonnet-4-6', w.ok && w.retried && f1.calls.length === 2 && f1.calls.every((c) => c.model === 'claude-sonnet-4-6'), [w, f1.calls.map((c) => c.model)]);
  ok('  the retry is told why', /names or identifies a person/.test(f1.calls[1].prompt));
  ok('  greeting and sign-off are the department\'s', /^Hi Ironside Fitness team,/.test(w.body) && /Cypress College Athletics$/.test(w.body), w.body);
  ok('  the facts the model sees hold no person', !/athlete_name|roster:\s*\[/i.test(f1.calls[0].prompt) && /THE ASK: Season presenting sponsor, \$1,500/.test(f1.calls[0].prompt));

  // ── 6. A TEAM SCAN NEVER READS AN AGENT TABLE ─────────────────────────────
  OUT.push('', '-- a team scan never touches agent tables --');
  // Canaries: an agent pool row under the same market key, and an agent
  // "contacted" row for a business the team should still be offered.
  await P.query(`INSERT INTO market_business_seen (market_key, brand) VALUES ('cypress, ca', 'Agent Only Pizza') ON CONFLICT DO NOTHING`);
  await P.query(`INSERT INTO brand_engagement (agent_id, athlete_id, brand_key, brand_name, lane, state)
                 VALUES ('ts-agent', 'ts-canary', 'place:tsp-ironside-fitness', 'Ironside Fitness', 'local', 'contacted') ON CONFLICT DO NOTHING`);
  const places = fakePlaces(FIXTURE.filter((f) => f.name !== 'Agent Only Pizza'));
  const rec = recording(P);
  const ai = fakeAi();
  const logsBefore = (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs`)).rows[0].n;
  const run = await TeamScan.runTeamScan(rec, { universityId: 'univ-cypress', teamId: TEAM, limit: 5, deps: { places, ai } });
  const touched = AGENT_TABLES.filter((t) => rec.seen.some((sql) => namesTable(sql, t)));
  ok('the scan ran and wrote asks', run.ok && run.drafts.length >= 4, [run.error, run.drafts && run.drafts.length, run.skipped]);
  ok('NO statement names brand_engagement, outreach_queue, deal_comps, athletes or any other agent table', touched.length === 0,
    touched.map((t) => [t, rec.seen.find((s) => namesTable(s, t)).slice(0, 160)]));
  ok('  the agent pool canary is not on the slate', !run.picks.some((p) => p.brand_name === 'Agent Only Pizza'));
  ok('  and the agent "contacted" canary did not exclude the team\'s business', run.picks.some((p) => p.brand_name === 'Ironside Fitness'));
  // Blocked businesses are KEPT in the pool, marked, so a later marker reaches
  // them (recheckPool); what matters is that none is ever on a slate.
  const bRows = (await P.query(`SELECT brand, blocked_reason FROM university_market_seen WHERE brand = ANY($1)`, [shouldBlock])).rows;
  ok('every blocked business in the university pool is marked with why',
    bRows.length === shouldBlock.length && bRows.every((r) => r.blocked_reason), bRows);
  ok('  and none of them is on the slate', !run.picks.some((p) => shouldBlock.includes(p.brand_name)), run.picks.map((p) => p.brand_name));
  ok('  and the run says what it blocked', run.discovery.blocked.length === shouldBlock.length, run.discovery.blocked.map((b) => b.name));
  const drafts = (await P.query(`SELECT * FROM university_drafts WHERE team_id = $1`, [TEAM])).rows;
  ok('every ask is left awaiting approval, naming an item and its price', drafts.length === run.drafts.length
    && drafts.every((d) => d.status === 'awaiting_approval' && d.body.includes(d.inventory_name) && d.body.includes(TW.money(d.price_cents))), drafts.map((d) => d.status));
  ok('  nothing was sent or written to the agent send table', (await P.query(`SELECT COUNT(*)::int n FROM outreach_logs`)).rows[0].n === logsBefore);
  ok('each pick carries a fit score out of 100 with its reasons', run.picks.every((p) => p.fit > 0 && p.fit <= 100 && p.fitReasons.length), run.picks.map((p) => [p.brand_name, p.fit]));
  ok('  the dealership is the top pick', run.picks[0] && run.picks[0].brand_name === 'Cypress Auto Mall Toyota', run.picks.map((p) => p.brand_name));

  const again = await TeamScan.runTeamScan(P, { universityId: 'univ-cypress', teamId: TEAM, limit: 5, deps: { places, ai } });
  const again2 = (await P.query(`SELECT COUNT(*)::int n FROM university_drafts WHERE team_id = $1`, [TEAM])).rows[0].n;
  ok('run again the same night: nothing already queued is asked twice', again.ok && again2 === drafts.length
    && !again.picks.some((p) => run.drafts.some((d) => d.brand === p.brand_name)), [again2, drafts.length, again.picks.map((p) => p.brand_name)]);

  // ── 6b. THE RACETRACK, THE SPREAD, AND THE PIRATES ────────────────────────
  // What the first real Cypress run got wrong: Los Alamitos Race Course (typed
  // `restaurant`) was asked as "your restaurant", all five were restaurants
  // because the pool read 20 arbitrary rows, and an ask argued a pirate theme
  // fit basketball.
  OUT.push('', '-- the racetrack, the spread and the pirates --');
  const B = (name, extra) => TeamScan.blockedFor({ name, types: ['restaurant', 'food', 'point_of_interest'], ...(extra || {}) });
  const bk = (b) => b && b.key;
  ok('Los Alamitos Race Course, typed restaurant, is blocked as gambling by its name', bk(B('Los Alamitos Race Course')) === 'gambling', B('Los Alamitos Race Course'));
  ok('  a track whose name says nothing is blocked by what Google says it is', bk(B('Santa Anita Park', { primary_type_label: 'Race Course' })) === 'gambling'
    && /Google describes it as "Race Course"/.test(B('Santa Anita Park', { primary_type_label: 'Race Course' }).why));
  const gamblingNames = ['Commerce Casino', 'The Bicycle Hotel & Casino', 'Hawaiian Gardens Card Club', 'Normandie Cardroom', 'Del Mar Thoroughbred Club',
    'Churchill Downs Racetrack', 'OTB Sports Lounge', 'Lucky Bingo Hall', 'Golden Keno', 'Super Lotto Mart', 'DraftKings at Casino Queen', 'FanDuel Sportsbook'];
  const missed = gamblingNames.filter((n) => bk(B(n)) !== 'gambling');
  ok(`  racetracks, casinos, card rooms, OTB, bingo, keno, lottery and the betting brands are all blocked (${gamblingNames.length})`, missed.length === 0, missed);
  ok('  anything Google describes as a bar is alcohol for a team', bk(B('Tavern on Main', { primary_type: 'sports_bar' })) === 'alcohol'
    && bk(B('The Local', { primary_type_label: 'Bar and grill' })) === 'alcohol');
  const fine = ['Pirates Dinner Adventure', 'Chuze Fitness', 'Select Physical Therapy', 'SchoolsFirst Federal Credit Union', 'Boulton Orthodontics',
    'Bet Tzedek Legal Services', 'Race Street Cafe', 'Downs Family Dentistry', 'K1 Speed Indoor Kart Racing'];
  ok('  and ordinary businesses are not (including "race", "bet" and "downs" in other senses)', fine.every((n) => !B(n)), fine.filter((n) => B(n)).map((n) => [n, B(n)]));

  const PM = require(REPO + 'server/services/placesMarket.js');
  ok('discovery files a place by what it IS, not by the search that found it',
    PM.categoryFor({ primary_type: 'race_course' }, 'restaurant') === 'local'
    && PM.categoryFor({ primary_type: 'physiotherapist' }, 'restaurant') === 'health'
    && PM.categoryFor({ primary_type: 'korean_restaurant' }, 'cafe') === 'restaurant'
    && PM.categoryFor({ primary_type_label: 'Orthodontist' }, 'dentist') === 'health'
    && PM.categoryFor({}, 'gym') === 'gym');
  ok('  and asks Google for its description of the place', /'primaryTypeDisplayName'/.test(read('server/services/placesMarket.js')));

  // The pool at a market of its own: fourteen high-fit restaurants (the old
  // read took 20 rows and every one was a restaurant), the four businesses the
  // real run missed, a dealership, and the racetrack as an OLD unmarked row.
  const MK2 = 'tspread, zz';
  await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK2]);
  const poolRows = [];
  for (let i = 0; i < 14; i++) poolRows.push([`Korean BBQ ${i}`, 'restaurant', 'korean_restaurant', 'Korean restaurant', 70 - i]);
  poolRows.push(['Chuze Fitness', 'gym', 'gym', 'Gym', 83], ['Select Physical Therapy', 'health', 'physiotherapist', 'Physical therapist', 80],
    ['SchoolsFirst Federal Credit Union', 'bank', 'bank', 'Credit union', 78], ['Boulton Orthodontics', 'health', 'dentist', 'Orthodontist', 76],
    ['Cypress Toyota', 'dealership', 'car_dealer', 'Car dealer', 74], ['Los Alamitos Race Course', 'restaurant', null, null, 95]);
  for (const [brand, category, pt, label, fit] of poolRows) {
    await P.query(`INSERT INTO university_market_seen (market_key, brand, category, types, primary_type, primary_type_label, fit, fit_reasons, first_seen_at, last_seen_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'[]'::jsonb, NOW(), NOW())`, [MK2, brand, category, JSON.stringify(['restaurant', 'food']), pt, label, fit]);
  }
  const rc = await TeamScan.recheckPool(P, MK2);
  ok('the pool recheck finds the racetrack that was already in the pool, unmarked', rc.newlyBlocked.some((b) => b.brand === 'Los Alamitos Race Course' && /^gambling:/.test(b.reason)), rc);
  const tsub = Scout.teamSubject({ team: { id: 'tspread:mbb', university_id: 'univ-tspread', name: 'Test Spread MBB' }, university: { id: 'univ-tspread', name: 'Tspread', location: 'X, ZZ' }, marketKey: MK2 });
  const sl = await Scout.assembleSlate(P, { subject: tsub, limit: 5 });
  const names = sl.picks.map((p) => p.brand_name);
  const kinds = new Set(sl.picks.map((p) => p.businessCategory));
  ok('the racetrack is never on the slate, though it had the highest fit in the pool', !names.includes('Los Alamitos Race Course'), names);
  ok(`a team slate has a different kind of business in every seat (${kinds.size} kinds in ${sl.picks.length})`, sl.picks.length === 5 && kinds.size === 5, [...kinds]);
  ok('  Chuze Fitness, Select Physical Therapy and SchoolsFirst Credit Union are on it', ['Chuze Fitness', 'Select Physical Therapy', 'SchoolsFirst Federal Credit Union'].every((n) => names.includes(n)), names);
  ok('  and at most one restaurant', names.filter((n) => /Korean BBQ/.test(n)).length <= 1, names);
  ok('for a team, gym and health outweigh a restaurant; restaurant is no longer the top weight',
    TeamScan.CATEGORY_FIT.gym > TeamScan.CATEGORY_FIT.restaurant && TeamScan.CATEGORY_FIT.health > TeamScan.CATEGORY_FIT.restaurant
    && TeamScan.CATEGORY_FIT.bank > TeamScan.CATEGORY_FIT.restaurant);
  const ath = Scout.athleteSubject({ id: 'x' }, 'a');
  ok('  the agent slate keeps its own spread rule (3 kinds) and pool order', !ath.minCategories && Scout.MIN_CATEGORIES === 3);
  await P.query(`DELETE FROM university_market_seen WHERE market_key = $1`, [MK2]);

  const tctx = { university: { name: 'Cypress College' }, team: { name: "Men's Basketball", sport: 'Basketball' },
    business: { brand_name: 'Pirates Dinner Adventure', category: 'restaurant', kindLabel: 'Dinner theater' }, item: { name: 'Courtside banner', price_cents: 150000 } };
  const pirate = TW.checkAsk({ subject: 'Sponsor the Chargers', body: 'Your pirate theme is a natural match for basketball: bold and competitive. Courtside banner, $1,500. Reply to talk.' }, tctx);
  ok('an ask that argues from a theme is refused, with a reason the retry can use', !pirate.ok && /coincidence/.test(pirate.why), pirate);
  const honest = TW.checkAsk({ subject: 'Courtside banner for the Chargers', body: 'You are two miles from campus and home games bring students and families down Valley View all winter. A Courtside banner, $1,500, puts your name in front of them every home date. Can we talk this week?' }, tctx);
  ok('  an ask with a true reason passes', honest.ok, honest);
  ok('the prompt names coincidence reasoning, with the pirate example', /Never build the reason on a coincidence/.test(TW.buildPrompt(tctx)) && /pirate/.test(TW.buildPrompt(tctx)));
  ok('  and tells the model what the business actually is, in Google\'s words', /KIND OF BUSINESS: Dinner theater/.test(TW.facts(tctx)));

  // ── 7. THE ATHLETE PATH IS UNCHANGED ──────────────────────────────────────
  OUT.push('', '-- the agent path --');
  const recA = recording(P);
  await Scout.assembleSlate(recA, { agentId: 'ts-agent', athlete: { id: 'ts-canary', school: 'Cypress College', hasLocalMarket: true, marketKey: 'cypress, ca' }, limit: 3 });
  ok('an athlete slate still reads brand_engagement, outreach_queue and market_business_seen',
    ['brand_engagement', 'outreach_queue', 'market_business_seen'].every((t) => recA.seen.some((s) => namesTable(s, t))));
  ok('  and never a university table', !recA.seen.some((s) => /university_/.test(s)));

  // ── 8. THE CODE ITSELF ────────────────────────────────────────────────────
  OUT.push('', '-- the code --');
  const strip = (s) => s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const code = strip(read('server/services/teamScan.js')) + strip(read('server/services/teamWriter.js')) + strip(read('scripts/team-scan.js'));
  ok('teamScan, teamWriter and the script name no agent table', AGENT_TABLES.filter((t) => t !== 'users').every((t) => !namesTable(code.replace(/university_[a-z_]+/g, ''), t)),
    AGENT_TABLES.filter((t) => namesTable(code.replace(/university_[a-z_]+/g, ''), t)));
  ok('  and nothing in them can send', !/sendEmail|sendMail|gmail|outlook|resend|nodemailer|smtp/i.test(code));
  ok('the agent writer is untouched: still claude-sonnet-4-6', /'claude-sonnet-4-6'/.test(read('server/services/draftPrewarm.js')));
  ok('the script is in the admin runner and is not a portal route',
    /'team-scan': \{ file: 'scripts\/team-scan\.js'/.test(read('server/index.js')) && !/\/api\/university\/[a-z-]*scan/.test(read('server/index.js')));

  await clean();
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  try { await P.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('teamscan: FAILED', e); process.exit(1); });
