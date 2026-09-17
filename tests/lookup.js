'use strict';
// Runs from a checkout on any machine against the local test Postgres. The
// roster feeds are fixtures (proRosterFeeds._setFetchForTests) and the web
// stage is a stand-in for the DeepSeek search loop
// (athleteLookup._setSearchLoopForTests); no network, no key.
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/lookup.js           just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');

// ── THE ATHLETE LOOKUP AS A PERSONAL ASSISTANT ──────────────────────────────
//
// A name and a school (or a team) in; sport, position, class year, jersey,
// hometown, height, weight, handles, approximate follower counts and a
// highlight out, every field with the URL it was read from. College, high
// school and pro. Feeds first for a pro, then DeepSeek through Serper, never
// Anthropic. Cached 30 days. Cost on the ledger. Several at once, in
// parallel. Never a birth date.

const store = require(REPO + 'server/store.js');
const AL = require(REPO + 'server/services/athleteLookup.js');
const Feeds = require(REPO + 'server/services/proRosterFeeds.js');
const actions = require(REPO + 'server/services/assistantActions.js');
const Enrich = require(REPO + 'server/services/importEnrich.js');
const Ledger = require(REPO + 'server/services/aiLedger.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const P = () => store.pool;
const AG = 'lk-agent';

// ── THE FEED FIXTURES ────────────────────────────────────────────────────────
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const feedCalls = [];
const FIX = {
  [`${ESPN}/football/nfl/teams?limit=100`]: { sports: [{ leagues: [{ teams: [
    { team: { id: '7', displayName: 'Denver Broncos', location: 'Denver', name: 'Broncos', abbreviation: 'DEN' } },
    { team: { id: '3', displayName: 'Chicago Bears', location: 'Chicago', name: 'Bears', abbreviation: 'CHI' } },
  ] }] }] },
  [`${ESPN}/football/nfl/teams/7/roster`]: { athletes: [{ position: 'offense', items: [
    { fullName: 'Bo Nix', jersey: '10', position: { abbreviation: 'QB' }, displayHeight: '6\' 2"', displayWeight: '214 lbs', birthPlace: { city: 'Pinson', state: 'AL' }, college: { name: 'Oregon' }, dateOfBirth: '2000-02-25T08:00Z', age: 26, links: [{ rel: ['playercard'], href: 'https://www.espn.com/nfl/player/_/id/4426338/bo-nix' }] },
    { fullName: 'Courtland Sutton', jersey: '14', position: { abbreviation: 'WR' }, displayHeight: '6\' 4"', displayWeight: '216 lbs', birthPlace: { city: 'Brenham', state: 'TX' } },
  ] }] },
  [`${ESPN}/football/ufl/teams?limit=100`]: { sports: [{ leagues: [{ teams: [] }] }] },
  [`${ESPN}/football/cfl/teams?limit=100`]: { sports: [{ leagues: [{ teams: [{ team: { id: '9', displayName: 'Calgary Stampeders', location: 'Calgary', name: 'Stampeders' } }] }] }] },
  ['https://statsapi.mlb.com/api/v1/people/search?names=Bobby%20Witt%20Jr.&sportIds=1,11,12,13,14&hydrate=currentTeam']: { people: [
    { id: 677951, fullName: 'Bobby Witt Jr.', primaryNumber: '7', primaryPosition: { abbreviation: 'SS' }, height: '6\' 1"', weight: 190, birthCity: 'Colleyville', birthStateProvince: 'TX', birthDate: '2000-06-14', currentTeam: { id: 118, name: 'Kansas City Royals', locationName: 'Kansas City', sport: { id: 1 } } },
  ] },
  ['https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=Nathan%20MacKinnon']: [
    { playerId: 8477492, name: 'Nathan MacKinnon', positionCode: 'C', teamAbbrev: 'COL', teamName: 'Colorado Avalanche', sweaterNumber: 29, heightInInches: 72, weightInPounds: 200, birthCity: 'Halifax', birthStateProvince: 'NS', birthDate: '1995-09-01' },
  ],
  [`${ESPN}/hockey/nhl/teams?limit=100`]: { sports: [{ leagues: [{ teams: [{ team: { id: '17', displayName: 'Colorado Avalanche', location: 'Colorado', name: 'Avalanche', abbreviation: 'COL' } }] }] }] },
  [`${ESPN}/hockey/nhl/teams/17/roster`]: { athletes: [{ fullName: 'Nathan MacKinnon', jersey: '29', position: { abbreviation: 'C' }, displayHeight: '6\' 0"', displayWeight: '200 lbs', birthPlace: { city: 'Halifax', state: 'NS' } }] },
};
// This suite exercises every feed against fixtures; production runs MLB only
// (proRosterFeeds.enabledFeeds), so the rest are switched on here.
Feeds._setEnabledForTests(['MLB', 'ESPN', 'NHL', 'HOCKEYTECH', 'GLEAGUE']);
Feeds._setFetchForTests(async (url) => {
  feedCalls.push(url);
  if (/hockeytech\.com/.test(url)) return { SiteKit: { Teamsbyseason: [] } };          // the key rotated
  if (/stats\.nba\.com/.test(url)) throw new Error('HTTP 403');                          // refuses servers
  if (FIX[url]) return FIX[url];
  throw new Error('HTTP 404');
});

// ── THE WEB STAGE STAND-IN ───────────────────────────────────────────────────
// Answers by the name in the prompt, in the loop's shape: text with the JSON,
// the citations the searches returned, usage for the ledger.
const loopCalls = [];
const USAGE = { inputTokens: 1200, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 3 };
let loopDelayMs = 0;
const WEB = {
  'Ann Lee': { citations: ['https://auburntigers.com/sports/softball/roster/ann-lee', 'https://www.instagram.com/annlee_sb/', 'https://www.tiktok.com/@annlee', 'https://auburntigers.com/news/2025/all-sec'],
    athletes: [{ name: 'Ann Lee', school: 'Auburn University', sport: 'softball', position: 'SS', year: 'Junior', jersey: '4', hometown: 'Hoover, AL', hometownState: 'AL', height: '5-7',
      instagramHandle: '@AnnLee_sb', instagram: '12.3K', tiktokHandle: 'annlee', tiktok: 2100, highlight: '2025 SEC All-Freshman team; .341 in 2025',
      dob: '2005-01-01', age: 20, weight: '150 lbs',
      sources: { profile: 'https://auburntigers.com/sports/softball/roster/ann-lee', instagramHandle: 'https://www.instagram.com/annlee_sb/', instagram: 'https://www.instagram.com/annlee_sb/', tiktokHandle: 'https://www.tiktok.com/@annlee', tiktok: 'https://www.tiktok.com/@annlee', weight: 'https://made-up.example.com/not-searched', highlight: 'https://auburntigers.com/news/2025/all-sec' },
      sourceLabel: 'Auburn athletics', confidence: 92 }] },
  'Cam Doe': { citations: ['https://www.maxpreps.com/al/hoover/hoover-buccaneers/athletes/cam-doe/', 'https://www.ahsaa.com/'],
    athletes: [{ name: 'Cam Doe', school: 'Hoover High School', sport: 'football', position: 'WR', year: 'Class of 2027', jersey: '81', hometown: 'Hoover, AL',
      birthdate: '2008-05-01', highlight: '2025 6A first-team all-state', sources: { profile: 'https://www.maxpreps.com/al/hoover/hoover-buccaneers/athletes/cam-doe/' }, sourceLabel: 'MaxPreps', confidence: 88 }] },
  'Bo Nix': { citations: ['https://www.instagram.com/bonix/'], athletes: [{ name: 'Bo Nix', team: 'Denver Broncos', instagramHandle: 'bonix', instagram: 480000, highlight: '2024 Pro Bowl alternate', sources: { instagramHandle: 'https://www.instagram.com/bonix/', instagram: 'https://www.instagram.com/bonix/', highlight: 'https://www.instagram.com/bonix/' }, confidence: 90 }] },
  'Jordan Smith': { citations: ['https://gojacks.com/roster/jordan-smith', 'https://gojacks.com/mbb/roster/jordan-smith-2'],
    athletes: [{ name: 'Jordan Smith', school: 'Stephen F. Austin', sport: 'baseball', position: 'RHP', year: 'Sophomore', sources: { profile: 'https://gojacks.com/roster/jordan-smith' }, confidence: 70 },
      { name: 'Jordan Smith', school: 'Stephen F. Austin', sport: "men's basketball", position: 'G', year: 'Senior', sources: { profile: 'https://gojacks.com/mbb/roster/jordan-smith-2' }, confidence: 70 }] },
  'Nobody Real': { citations: [], athletes: [] },
  'Zed Zee': { citations: ['https://example-roster.edu/zed'], athletes: [{ name: 'Zed Zee', school: 'Troy University', sport: 'golf', position: null, year: 'Freshman', hometown: 'Dothan, AL', instagramHandle: 'zedzee', instagram: 900, sources: { profile: 'https://example-roster.edu/zed' }, confidence: 80 }] },
};
AL._setSearchLoopForTests(async (o) => {
  loopCalls.push(o);
  if (loopDelayMs) await new Promise((r) => setTimeout(r, loopDelayMs));
  const m = String(o.prompt).match(/^Name: (.+)$/m);
  const fx = WEB[m ? m[1].trim() : ''] || { citations: [], athletes: [] };
  return { text: JSON.stringify({ found: fx.athletes.length > 0, athletes: fx.athletes, searchNote: fx.athletes.length ? 'found' : 'nothing matched' }), citations: fx.citations, searches: 3, fetches: 1, usage: USAGE, apiMs: 10, rounds: 2 };
});

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  await P().query(`DELETE FROM athlete_lookup_cache WHERE cache_key LIKE '%|ann lee|%' OR cache_key LIKE '%|cam doe|%' OR cache_key LIKE '%|bo nix|%' OR cache_key LIKE '%|jordan smith|%' OR cache_key LIKE '%|nobody real|%' OR cache_key LIKE '%|zed zee|%' OR cache_key LIKE '%|bobby witt jr|%' OR cache_key LIKE '%|nathan mackinnon|%'`).catch(() => {});
  await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P().query(`INSERT INTO users (id,name,email,password,role) VALUES ($1,'Lk Agent','lk@x.com','x','agent') ON CONFLICT DO NOTHING`, [AG]);

  // ── 1. LEVELS ────────────────────────────────────────────────────────────
  OUT.push('-- which level --');
  ok('a pro is a pro when the caller says so', AL.levelOf({ name: 'x', athleteType: 'pro' }) === 'pro');
  ok('a high school is read off the school name', AL.levelOf({ name: 'x', school: 'Hoover High School' }) === 'high_school' && AL.levelOf({ name: 'x', school: 'IMG Academy' }) === 'high_school');
  ok('everything else is college, NAIA and JUCO included', AL.levelOf({ name: 'x', school: 'Auburn University' }) === 'college' && AL.levelOf({ name: 'x', school: 'Wallace State Community College' }) === 'college');
  ok('the prompts name the sites per level', /maxpreps/.test(AL.promptFor('high_school', { name: 'x', school: 'Hoover High School' })) && /state high school athletic association/.test(AL.promptFor('high_school', { name: 'x' }))
    && /naia\.org/.test(AL.promptFor('college', { name: 'x' })) && /njcaa\.org/.test(AL.promptFor('college', { name: 'x' })) && /Division III/.test(AL.promptFor('college', { name: 'x' })) && /PREFER Wikipedia and the team's official roster page/.test(AL.promptFor('pro', { name: 'x' })));
  ok('  and every prompt forbids a birth date; the high school one says minor', ['college', 'high_school', 'pro'].every((l) => /Never report a birth date, a birthday or an age/.test(AL.promptFor(l, { name: 'x' }))) && /This athlete is a minor/.test(AL.promptFor('high_school', { name: 'x' })));

  // ── 2. COLLEGE: EVERY FIELD FROM A SOURCE ────────────────────────────────
  OUT.push('', '-- college: the fields, each with its source --');
  loopCalls.length = 0;
  const ann = await AL.resolveAthlete(null, { name: 'Ann Lee', school: 'Auburn University' }, { agentId: AG, force: true });
  const a = ann.candidates[0] || {};
  ok('found, one candidate, college', ann.found && ann.candidates.length === 1 && ann.level === 'college' && a.name === 'Ann Lee', ann);
  ok('  sport, position, class year, jersey, hometown and state, height', a.sport === 'softball' && a.position === 'SS' && a.year === 'Junior' && a.jersey === '4' && a.hometown === 'Hoover, AL' && a.hometownState === 'AL' && a.height === '5-7', a);
  ok('  handles cleaned, counts parsed ("12.3K"), approximate and dated', a.instagramHandle === 'annlee_sb' && a.instagram === 12300 && a.tiktokHandle === 'annlee' && a.tiktok === 2100 && a.followersApprox === true && /^\d{4}-\d{2}-\d{2}$/.test(a.followersAsOf), a);
  ok('  the highlight, from its own page', a.highlight === '2025 SEC All-Freshman team; .341 in 2025' && a.sources.highlight === 'https://auburntigers.com/news/2025/all-sec', a.sources);
  ok('  every kept field has a source URL, the profile inherited where no other was given', ['sport', 'position', 'year', 'jersey', 'hometown', 'height'].every((f) => a.sources[f] === 'https://auburntigers.com/sports/softball/roster/ann-lee') && a.sources.instagram === 'https://www.instagram.com/annlee_sb/', a.sources);
  ok('  A FIELD WHOSE SOURCE THE SEARCH NEVER RETURNED IS BLANK (weight cited a made-up page)', a.weight === null && a.sources.weight === undefined, [a.weight, a.sources.weight]);
  ok('  NO BIRTH DATE OR AGE, whatever the page said', a.dob === undefined && a.age === undefined && !Object.keys(a).some((k) => /birth|dob|\bage\b/i.test(k)) && !Object.keys(a.sources).some((k) => /birth|dob|age/i.test(k)));
  ok('  the old flat fields still ride along for the form', a.stats === a.highlight && a.athleteType === 'college' && a.confidence === 92 && a.sourceLabel === 'Auburn athletics' && a.schoolTier === 'mid-mid', [a.stats, a.athleteType, a.confidence, a.sourceLabel, a.schoolTier]);
  ok('  the web stage ran once, under lookup.college with the name as the brand, Serper preferred', loopCalls.length === 1 && loopCalls[0].ctx.site === 'lookup.college' && loopCalls[0].ctx.brand === 'Ann Lee' && loopCalls[0].ctx.agentId === AG && loopCalls[0].maxSearches === 4, loopCalls[0] && loopCalls[0].ctx);
  ok('  cost per lookup is priced from the loop usage', ann.costUsd > 0 && ann.costUsd === Ledger.estimateUsd('deepseek-v4-flash', USAGE, 'deepseek') && ann.searches === 3, ann.costUsd);
  ok('  a sport the agent typed is kept, sourced "agent", when the pages had none', (await AL.resolveAthlete(null, { name: 'Zed Zee', school: 'Troy University', sport: 'golf', position: 'Walk-on' }, { force: true })).candidates[0].sources.position === 'agent');

  // ── 3. HIGH SCHOOL ───────────────────────────────────────────────────────
  OUT.push('', '-- high school: MaxPreps, never a birth date --');
  loopCalls.length = 0;
  const cam = await AL.resolveAthlete(null, { name: 'Cam Doe', school: 'Hoover High School' }, { force: true });
  const c = cam.candidates[0] || {};
  ok('found on MaxPreps as a high school athlete', cam.found && cam.level === 'high_school' && c.school === 'Hoover High School' && c.position === 'WR' && c.year === 'Class of 2027' && c.jersey === '81' && c.sources.position === 'https://www.maxpreps.com/al/hoover/hoover-buccaneers/athletes/cam-doe/', c);
  ok('  the prompt was the high school prompt and the birthdate the page carried was dropped', /HIGH SCHOOL athlete/.test(loopCalls[0].prompt) && loopCalls[0].ctx.site === 'lookup.high_school' && c.birthdate === undefined && c.dob === undefined);
  ok('  athleteType stays college for the app (a high school athlete is placed by their school)', c.athleteType === 'college' && c.level === 'high_school');

  // ── 4. PRO: THE FEEDS FIRST, THEN THE WEB FOR THE REST ───────────────────
  OUT.push('', '-- pro: roster feeds, then cited search --');
  feedCalls.length = 0; loopCalls.length = 0;
  const bo = await AL.resolveAthlete(null, { name: 'Bo Nix', team: 'Broncos', sport: 'football', athleteType: 'pro' }, { force: true });
  const b = bo.candidates[0] || {};
  ok('the NFL feed found him on the Broncos roster: position, jersey, height, weight, hometown, college', bo.found && bo.level === 'pro' && b.team === 'Denver Broncos' && b.position === 'QB' && b.jersey === '10' && b.height === '6\' 2"' && b.weight === '214 lbs' && b.hometown === 'Pinson, AL' && b.college === 'Oregon' && b.league === 'NFL', b);
  ok('  every feed field is sourced to the feed (the ESPN player page)', ['position', 'jersey', 'height', 'weight', 'hometown'].every((f) => b.sources[f] === 'https://www.espn.com/nfl/player/_/id/4426338/bo-nix'), b.sources);
  ok('  the web stage was told what the feed had and added the handle, the count and the highlight', /A roster feed already confirmed: Bo Nix, Denver Broncos/.test(loopCalls[0].prompt) && b.instagramHandle === 'bonix' && b.instagram === 480000 && b.highlight === '2024 Pro Bowl alternate' && b.sources.instagram === 'https://www.instagram.com/bonix/', b);
  ok('  the feed birth date and age were never copied', b.dateOfBirth === undefined && b.age === undefined && !/birth/i.test(JSON.stringify(b)));
  ok('  UFL and CFL were tried too, and said why they had nothing', feedCalls.some((u) => /football\/ufl\/teams/.test(u)) && feedCalls.some((u) => /football\/cfl\/teams/.test(u)) && bo.notes.some((n) => /^UFL: teams feed answered with no teams/.test(n)) && bo.notes.some((n) => /^CFL: no team matches "Broncos"/.test(n)), bo.notes);
  ok('  the merged label says feed + web, confidence high', /ESPN NFL roster \+ web/.test(b.sourceLabel) && b.confidence >= 90 && b.stats === b.highlight && b.knownFor === b.highlight);

  const witt = await AL.resolveAthlete(null, { name: 'Bobby Witt Jr.', team: 'Royals', sport: 'baseball', athleteType: 'pro' }, { force: true });
  const w = witt.candidates[0] || {};
  ok('MLB StatsAPI: found by name, position, number, height, hometown, team city, sourced to the MLB player page', witt.found && w.position === 'SS' && w.jersey === '7' && w.hometown === 'Colleyville, TX' && w.city === 'Kansas City' && w.league === 'MLB' && w.sources.jersey === 'https://www.mlb.com/player/677951', w);
  const mac = await AL.resolveAthlete(null, { name: 'Nathan MacKinnon', team: 'Colorado Avalanche', sport: 'hockey', athleteType: 'pro' }, { force: true });
  const mk = mac.candidates[0] || {};
  ok('NHL: the league search and the ESPN roster agree and merge into one candidate', mac.found && mac.candidates.length === 1 && mk.position === 'C' && mk.jersey === '29' && mk.hometown === 'Halifax, NS', mac.candidates);
  ok('  AHL and ECHL answered with no teams (rotated key), reported as notes, no error', mac.notes.some((n) => /^AHL: HockeyTech answered with no teams/.test(n)) && mac.notes.some((n) => /^ECHL: /.test(n)), mac.notes);
  const gl = await Feeds.searchFeeds({ name: 'Some Player', sport: "men's basketball", team: 'Iowa Wolves' });
  ok('G League: a refused stats host is a note and the search goes on', gl.notes.some((n) => /^G League: stats host refused/.test(n)) && gl.feedsTried.includes('G League'), gl.notes);
  ok('leaguesForSport: a bare sport names every league of it', Feeds.leaguesForSport('soccer').join(',') === 'MLS,NWSL,USL Championship,USL League One' && Feeds.leaguesForSport("women's basketball").join(',') === 'WNBA' && Feeds.leaguesForSport('hockey').join(',') === 'NHL,AHL,ECHL');
  ok('teamMatches: nickname, city, abbreviation-ish', Feeds.teamMatches('Broncos', 'Denver Broncos') && Feeds.teamMatches('Denver', 'Denver Broncos') && Feeds.teamMatches('New York City FC', 'New York City FC') && !Feeds.teamMatches('Bears', 'Denver Broncos'));

  // ── 5. MATCHING: UP TO THREE, SPORT ONLY WHEN IT DISAMBIGUATES ───────────
  OUT.push('', '-- matching: candidates, and when the sport is asked --');
  const js = await AL.resolveAthlete(null, { name: 'Jordan Smith', school: 'Stephen F. Austin' }, { force: true });
  ok('two people, two sports: both shown with sport, position and class year, needsSport true', js.found && js.candidates.length === 2 && js.needsSport === true && js.candidates.every((x) => x.sport && x.position && x.year), js.candidates.map((x) => [x.sport, x.position, x.year]));
  ok('one clear match: needsSport false, and the sport is not asked for', ann.needsSport === false && cam.needsSport === false);
  const nobody = await AL.resolveAthlete(null, { name: 'Nobody Real', school: 'Auburn University' }, { force: true });
  ok('nothing matched: found false, needsSport true, the note says so', nobody.found === false && nobody.needsSport === true && /nothing matched/.test(nobody.message), nobody);
  ok('autoSelect only on one candidate at 95 or better', ann.autoSelect === false && js.autoSelect === false);

  // ── 6. THE CACHE ─────────────────────────────────────────────────────────
  OUT.push('', '-- cached 30 days by name and school --');
  loopCalls.length = 0;
  const again = await AL.resolveAthlete(null, { name: 'ann  lee', school: 'Auburn University' });
  ok('the same name and school (case and spacing folded) comes back from the cache with no search', again.cached === true && again.checkedAt && again.candidates[0].instagram === 12300 && loopCalls.length === 0, { cached: again.cached, calls: loopCalls.length });
  const row = (await P().query(`SELECT level, found, cost_usd, checked_at FROM athlete_lookup_cache WHERE cache_key = $1`, [AL.cacheKey('college', { name: 'Ann Lee', school: 'Auburn University' })])).rows[0];
  ok('  the row carries the level, found and the cost', row && row.level === 'college' && row.found === true && Number(row.cost_usd) === ann.costUsd, row);
  ok('  a miss is cached too', (await P().query(`SELECT found FROM athlete_lookup_cache WHERE cache_key = $1`, [AL.cacheKey('college', { name: 'Nobody Real', school: 'Auburn University' })])).rows[0].found === false);
  await P().query(`UPDATE athlete_lookup_cache SET checked_at = NOW() - INTERVAL '31 days' WHERE cache_key = $1`, [AL.cacheKey('college', { name: 'Ann Lee', school: 'Auburn University' })]);
  const stale = await AL.resolveAthlete(null, { name: 'Ann Lee', school: 'Auburn University' });
  ok('  after 30 days it is looked up again', stale.cached === false && loopCalls.length === 1);
  loopCalls.length = 0;
  await AL.resolveAthlete(null, { name: 'Ann Lee', school: 'Auburn University' }, { force: true });
  ok('  force reads past the cache', loopCalls.length === 1);
  ok('  the cache key is by level and by team for a pro', AL.cacheKey('pro', { name: 'Bo Nix', team: 'Denver Broncos' }) === 'pro|bo nix|denver broncos' && AL.cacheKey('college', { name: "D'Andre Smith-Jones", school: 'Auburn' }) === 'college|dandre smithjones|auburn');

  // ── 7. BATCH: IN PARALLEL, IN ORDER ──────────────────────────────────────
  OUT.push('', '-- several at once --');
  loopDelayMs = 150; loopCalls.length = 0;
  const t0 = Date.now();
  const many = await AL.resolveMany(null, [{ name: 'Ann Lee', school: 'Auburn University' }, { name: 'Cam Doe', school: 'Hoover High School' }, { name: 'Zed Zee', school: 'Troy University' }], { force: true });
  const took = Date.now() - t0;
  loopDelayMs = 0;
  ok('three lookups ran in parallel (three 150ms searches in well under 450ms) and came back in order', loopCalls.length === 3 && took < 400 && many[0].candidates[0].name === 'Ann Lee' && many[1].candidates[0].name === 'Cam Doe' && many[2].candidates[0].name === 'Zed Zee', { took, order: many.map((r) => r.candidates[0] && r.candidates[0].name) });

  // ── 8. THE ASSISTANT TOOL AND THE CARDS ──────────────────────────────────
  OUT.push('', '-- the assistant: one call for several, one card per athlete, one-step Add --');
  actions._setLookupForTests(null);
  const one = await actions.resolveCall('lookup_athlete', { name: 'Ann Lee', school: 'Auburn University' }, { agentId: AG, principal: { kind: 'agent', id: AG }, session: {} });
  ok('a single lookup answers the model with the profile and hands the page one card', one.ok && one.data.found === true && one.data.candidates[0].instagramHandle === 'annlee_sb' && one.data.needsSport === false && one.directive && one.directive.kind === 'profile_cards' && one.directive.cards.length === 1 && one.directive.cards[0].sources.position, one);
  const batch = await actions.resolveCall('lookup_athlete', { athletes: [{ name: 'Ann Lee', school: 'Auburn University' }, { name: 'Bo Nix', team: 'Broncos', sport: 'football', athleteType: 'pro' }, { name: 'Nobody Real', school: 'Auburn University' }] }, { agentId: AG, principal: { kind: 'agent', id: AG }, session: {} });
  ok('a batch answers per athlete, in order, with a card for each candidate and none for a miss', batch.ok && batch.data.results.length === 3 && batch.data.results[0].found && batch.data.results[1].candidates[0].jersey === '10' && batch.data.results[2].found === false && batch.data.results[2].needsSport === true && batch.directive.cards.length === 2, batch.data.results.map((r) => r.found));
  ok('  the tool schema offers the athletes list', actions.toolDefsFor('onboarding').find((t) => t.name === 'lookup_athlete').input_schema.properties.athletes.type === 'array');
  const card = one.directive.cards[0];
  const added = await actions.resolveCall('add_athlete', { name: card.name, sport: card.sport, school: card.school, position: card.position, year: 'Senior', jersey: card.jersey, hometown: card.hometown, height: card.height,
    instagramHandle: card.instagramHandle, instagram: card.instagram, tiktokHandle: card.tiktokHandle, tiktok: card.tiktok, highlight: card.highlight, sources: Object.assign({}, card.sources, { year: 'agent' }) },
  { agentId: AG, principal: { kind: 'agent', id: AG }, session: {} });
  const saved = (await P().query(`SELECT data FROM athletes WHERE agent_id = $1 AND data->>'name' = 'Ann Lee'`, [AG])).rows[0];
  ok('Add saves the card as shown, a correction ("she is a senior") sourced to the agent', added.ok && added.data.added === true && saved && saved.data.position === 'SS' && saved.data.year === 'Senior' && saved.data.jerseyNumber === '4' && saved.data.instagramHandle === 'annlee_sb' && saved.data.tiktokHandle === 'annlee' && saved.data.instagram === 12300 && saved.data.tiktok === 2100 && saved.data.height === '5-7' && saved.data.stats === card.highlight, saved && saved.data);
  ok('  with the per-field sources on the record, and the counts marked as a dated web estimate', saved.data.lookupSources.position === 'https://auburntigers.com/sports/softball/roster/ann-lee' && saved.data.lookupSources.year === 'agent' && saved.data.igStatsSource === 'web_estimate' && saved.data.igStatsFetchedAt && saved.data.lookupAt);
  ok('  no birth date reached the record', saved.data.dob === '' && !('age' in saved.data));

  // ── 9. THE IMPORT FILLS BLANK COLUMNS ────────────────────────────────────
  OUT.push('', '-- the spreadsheet import: blanks filled, sheet values kept --');
  await store.saveAthlete('lk-imp-1', { id: 'lk-imp-1', agentId: AG, name: 'Zed Zee', sport: 'golf', school: 'Troy University', athleteType: 'college', position: '', year: '', hometown: '', instagramHandle: '', instagram: 0, importedFrom: 'csv' });
  await store.saveAthlete('lk-imp-2', { id: 'lk-imp-2', agentId: AG, name: 'Cam Doe', sport: 'football', school: 'Hoover High School', athleteType: 'college', position: 'TE', year: '', instagram: 5000, igStatsSource: 'manual', importedFrom: 'csv' });
  const en = await Enrich.enrichImportedAthletes(AG, [{ id: 'lk-imp-1' }, { id: 'lk-imp-2' }, { id: 'not-mine' }]);
  const z = await store.getAthlete('lk-imp-1'), cd = await store.getAthlete('lk-imp-2');
  ok('blank columns are filled from the lookup, each with its source', en.lookedUp === 2 && z.year === 'Freshman' && z.hometown === 'Dothan, AL' && z.instagramHandle === 'zedzee' && z.instagram === 900 && z.lookupSources.hometown === 'https://example-roster.edu/zed' && z.igStatsSource === 'web_estimate' && z.reachSource === 'lookup', z);
  ok('  the sheet\'s own values are never overwritten (position TE kept, manual count kept), only the blanks (class year, jersey) filled', cd.position === 'TE' && cd.instagram === 5000 && cd.igStatsSource === 'manual' && cd.year === 'Class of 2027' && cd.jerseyNumber === '81', cd);
  ok('  a field the lookup could not source stays blank (Zed has no position on the page)', z.position === '' && !('position' in z.lookupSources));
  ok('patchFor refuses a candidate whose school disagrees', Enrich.patchFor({ name: 'Zed Zee', school: 'Troy University', athleteType: 'college' }, { name: 'Zed Zee', school: 'Auburn University', position: 'G', sources: { position: 'https://x' } }, AL) === null);

  // ── 10. THE WIRING ───────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const src = (p) => fs.readFileSync(REPO + p, 'utf8');
  const lk = src('server/services/athleteLookup.js'), cli = src('public/assistant.js'), idx = src('public/index.html'), srv = src('server/index.js');
  ok('DeepSeek and Serper, not Anthropic: no SDK, no Haiku model, Serper preferred', !/@anthropic-ai\/sdk/.test(lk) && !/claude-/.test(lk) && /const serper = WST\.PROVIDERS\.serper;\s*return serper\.key\(\) \? serper : WST\.provider\(\);/.test(lk));
  ok('the pitch writer was not touched', !/athleteLookup|proRosterFeeds/.test(src('server/services/pitchWriter.js')));
  ok('the cache table exists', /CREATE TABLE IF NOT EXISTS athlete_lookup_cache/.test(src('server/store.js')));
  ok('the page draws profile cards with an Add button that sends the agent\'s own words', /d\.kind === 'profile_cards'/.test(cli) && /naSendText\('Add ' \+ c\.name \+ ' as shown\.'\)/.test(cli) && /Sources: /.test(cli) && /approx\., checked/.test(cli));
  ok('the Add Client button says how long, and fills the handle', /Searching, this takes about 20 seconds/.test(idx) && /if \(data\.instagramHandle\) \{ const h = document\.getElementById\('a_handle'\)/.test(idx));
  ok('  and its route carries the agent for the ledger', /resolveAthlete\(ai, \{ name, school, sport, position, year, athleteType, team, city \}, \{ agentId: req\.session\.userId \}\)/.test(srv));
  ok('the import commit enriches in the background and says so', /enrichImportedAthletes\(user\.id, created\.slice\(0, IMPORT_ENRICH_MAX\)\)/.test(srv) && /needsFix: pv\.needsFix\.length, filling, enriching \}/.test(srv));
  ok('spend-breakdown has the lookups block, cost per lookup by level', /ATHLETE LOOKUPS/.test(src('scripts/spend-breakdown.js')) && /per lookup/.test(src('scripts/spend-breakdown.js')));
  ok('the hit-rate script exists and reports by level', /HIT RATE BY LEVEL/.test(src('scripts/lookup-hitrate.js')) && /--force/.test(src('scripts/lookup-hitrate.js')));
  ok('the brief: no sport question unless needsSport, one card per athlete, corrections without re-asking', /Ask for the sport ONLY if needsSport is true/.test(src('server/services/assistantOnboarding.js')) && /set that field's source to "agent", and call add_athlete without asking again/.test(src('server/services/assistantOnboarding.js')) && /date of birth is never looked up/.test(src('server/services/assistantOnboarding.js')));

  // ── 11. HIT RATE ON THE FIXTURES, BY LEVEL ───────────────────────────────
  // What this suite exercised, not a measurement of the live web:
  // scripts/lookup-hitrate.js measures that with real keys.
  OUT.push('', '-- hit rate on the fixtures (not the live web) --');
  const runs = [['college', ann], ['college', js], ['college', nobody], ['high_school', cam], ['pro', bo], ['pro', witt], ['pro', mac]];
  const byLevel = {};
  for (const [l, r] of runs) { const g = byLevel[l] || { n: 0, found: 0 }; g.n++; if (r.found) g.found++; byLevel[l] = g; }
  for (const [l, g] of Object.entries(byLevel)) OUT.push(`  ${l.padEnd(12)} ${g.found}/${g.n} found`);
  ok('every level was exercised', Object.keys(byLevel).length === 3);

  await P().query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM users WHERE id = $1`, [AG]).catch(() => {});
  await P().query(`DELETE FROM athlete_lookup_cache WHERE cache_key LIKE '%|ann lee|%' OR cache_key LIKE '%|cam doe|%' OR cache_key LIKE '%|bo nix|%' OR cache_key LIKE '%|jordan smith|%' OR cache_key LIKE '%|nobody real|%' OR cache_key LIKE '%|zed zee|%' OR cache_key LIKE '%|bobby witt jr|%' OR cache_key LIKE '%|nathan mackinnon|%' OR cache_key LIKE '%|some player|%'`).catch(() => {});
  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  await P().end();
  process.exit(F ? 1 : 0);
}
main().catch((e) => { console.error('THREW', e); process.exit(1); });
