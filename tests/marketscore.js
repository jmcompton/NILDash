'use strict';
// Runs against the local test Postgres.
//
//   node tests/marketscore.js
//
// ── THE MARKET SCORE (services/marketScore, MARKET_MIX_ON) ──────────────────
// 0-100 per athlete from level and sport, social reach, performance, media
// and market size; stored weekly with the reasons. Missing data scores zero
// and lowers confidence; nothing is guessed. The score sets the tier: Local
// Star, Rising, Regional, National.
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
process.env.PGUSER = process.env.PGUSER || 'postgres';
process.env.PGDATABASE = process.env.PGDATABASE || 'postgres';
const TEST_INIT_WAIT_MS = parseInt(process.env.TEST_INIT_WAIT_MS, 10) || 6000;
const fs = require('fs');
const store = require(REPO + 'server/store');
const MS = require(REPO + 'server/services/marketScore');
const AR = require(REPO + 'server/services/athleteRecord');
const SR = require(REPO + 'server/services/schoolResolver');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g).slice(0, 700) : '')); } };
const loc = (s) => { const r = SR.resolveSchool(s); return r && r.city ? r : null; };
const NOW = new Date('2026-10-15T12:00:00Z');
const rec = (d) => AR.resolveAthlete({ id: 'x', data: d }, { schoolLocation: loc });
const scoreOf = (d, extra) => MS.score({ rec: rec(d), raw: d, cols: {}, ig: null, news: null, cityPop: null, pool: null, now: NOW, ...(extra || {}) });

async function main() {
  await new Promise((r) => setTimeout(r, TEST_INIT_WAIT_MS));
  // ── 1. LEVEL AND SPORT ─────────────────────────────────────────────────────
  OUT.push('-- level and sport --');
  const lvl = (school, sport, extra) => MS.levelOf(rec({ school, sport, ...(extra || {}) }), (MS.sportOf(sport) || {}).key);
  ok('Alabama is Power 4 (15)', lvl('University of Alabama', 'football').level === 'p4' && lvl('University of Alabama', 'football').pts === 15);
  ok('  "UNC Chapel Hill", "Cal", "BYU", "Texas A&M" and Notre Dame are Power 4',
    ['University of North Carolina at Chapel Hill', 'Cal', 'BYU', 'Texas A&M University', 'Notre Dame'].every((s) => lvl(s, 'football').level === 'p4'),
    ['University of North Carolina at Chapel Hill', 'Cal', 'BYU', 'Texas A&M University', 'Notre Dame'].map((s) => lvl(s, 'football')));
  ok('Boise State and Miami (OH) are Group of 5 (11)', lvl('Boise State', 'football').level === 'g5' && lvl('Miami (OH)', 'football').level === 'g5' && lvl('Boise State', 'football').pts === 11);
  ok('Washington State is Group of 5 and Washington is Power 4', lvl('Washington State University', 'football').level === 'g5' && lvl('University of Washington', 'football').level === 'p4');
  const miami = lvl('Miami', 'baseball');
  ok('a bare "Miami" is two schools: counted at the lower level, half confidence, and the reason says so',
    miami.level === 'g5' && miami.confidence === 0.5 && /Miami \(FL\)/.test(miami.why) && /Miami \(OH\)/.test(miami.why), miami);
  ok('  Miami with its state set is Power 4', lvl('Miami', 'baseball', { state: 'FL' }).level === 'p4' || lvl('University of Miami', 'baseball').level === 'p4', [lvl('Miami', 'baseball', { state: 'FL' }), lvl('University of Miami', 'baseball')]);
  ok('Gonzaga is high-major for basketball, other Division I for soccer',
    lvl('Gonzaga', "men's basketball").level === 'p4' && lvl('Gonzaga', 'soccer').level === 'fcs', [lvl('Gonzaga', "men's basketball"), lvl('Gonzaga', 'soccer')]);
  ok('an agent-set D2 is Division II (5); D3 is 3; NAIA 4; JUCO 3',
    lvl('Some College', 'soccer', { division: 'D2' }).pts === 5 && lvl('Some College', 'soccer', { division: 'D3' }).pts === 3
    && lvl('Some College', 'soccer', { division: 'NAIA' }).pts === 4 && lvl('Some College', 'soccer', { division: 'JUCO' }).pts === 3);
  ok('Bentley (the D2 list) is Division II without the agent saying so', lvl('Bentley University', 'soccer').level === 'd2', lvl('Bentley University', 'soccer'));
  ok('a two-year college is JUCO', lvl('Cypress College', 'baseball').level === 'juco', lvl('Cypress College', 'baseball'));
  ok('a high school is HS (2)', lvl('Hoover High School', 'football').level === 'hs' && lvl('Hoover High School', 'football').pts === 2, lvl('Hoover High School', 'football'));
  ok('a pro is 15', MS.levelOf({ athleteType: 'pro' }).pts === 15);
  const unk = lvl('Zephyr Quill Polytechnic', 'football');
  ok('an unknown school scores 0 at confidence 0 (never guessed)', unk.level === null && unk.pts === 0 && unk.confidence === 0, unk);
  ok('revenue sports weigh more: football 10 = men\'s basketball 10 > women\'s basketball 9 > volleyball 7 > softball 6 > soccer 5 > golf 4',
    MS.sportOf('Football').pts === 10 && MS.sportOf("Men's Basketball").pts === 10 && MS.sportOf("Women's Basketball").pts === 9
    && MS.sportOf('Volleyball').pts === 7 && MS.sportOf('Softball').pts === 6 && MS.sportOf('Soccer').pts === 5 && MS.sportOf('Golf').pts === 4);
  ok('  a bare "basketball" takes the lower (women\'s) weight and says so', MS.sportOf('Basketball').pts === 9 && /not recorded/.test(MS.sportOf('Basketball').note));
  ok('  flag football is not football', MS.sportOf('flag football').key !== 'football');

  // ── 2. SOCIAL ─────────────────────────────────────────────────────────────
  OUT.push('', '-- social reach --');
  ok('reach is a log scale: 100 -> 0, 10,000 -> 11, 1,000,000 -> 22', MS.reachPoints(100) === 0 && MS.reachPoints(10000) === 11 && MS.reachPoints(1000000) === 22);
  ok('engagement bands: 8% -> 8, 5% -> 6.5, 3% -> 5, 1% -> 1.5, unknown -> 0',
    MS.engagementPoints(8) === 8 && MS.engagementPoints(5) === 6.5 && MS.engagementPoints(3) === 5 && MS.engagementPoints(1) === 1.5 && MS.engagementPoints(null) === 0);
  const none = MS.socialOf({ rec: rec({ name: 'A' }), raw: {}, cols: {}, ig: null, now: NOW });
  ok('no follower count: 0 points, confidence 0', none.points === 0 && none.confidence === 0 && none.missing.includes('follower counts'), none);
  const typed = MS.socialOf({ rec: rec({ instagram: 20000, engagement: 4, reachSource: 'agent', reachAsOf: '2026-09-01' }), raw: {}, cols: {}, ig: null, now: NOW });
  const conn = MS.socialOf({ rec: rec({ instagram: 20000 }), raw: {}, cols: {}, now: NOW,
    ig: { followers_count: 20000, engagement_rate: 0.04, fetched_at: '2026-10-10' } });
  ok('a connected Instagram is read first and carries full confidence', conn.confidence === 1 && /connected Instagram/.test(conn.reasons[0]), conn);
  ok('  a hand-typed count scores the same points at lower confidence, and says who typed it and when',
    typed.points === conn.points && typed.confidence < conn.confidence && /entered by their agent, as of 1 Sep 2026/.test(typed.reasons[0]), [typed, conn]);
  const tt = MS.socialOf({ rec: rec({ instagram: 10000, tiktok: 10000 }), raw: {}, cols: { twitter_followers: 4000 }, ig: null, now: NOW });
  ok('every platform is listed; TikTok and X count at half', tt.platforms.length === 3 && tt.effectiveReach === 17000 && /TikTok 10,000/.test(tt.reasons[0]) && /X 4,000/.test(tt.reasons[0]), tt);

  // ── 3. PERFORMANCE ────────────────────────────────────────────────────────
  OUT.push('', '-- performance --');
  const p1 = MS.performanceOf({ stats: 'First-team All-SEC, 3-year starter, 14.2 ppg', knownFor: 'four-star recruit' });
  ok('all-conference, starter, a stat line and recruiting stars are read from the record, each naming its text',
    p1.signals.map((s) => s.key).sort().join(',') === 'all_conference,stars4,starter,stats' && p1.points === 14 && p1.reasons.every((r) => /\(stats: |\(known for: /.test(r)), p1);
  ok('  All-American is not also counted as all-conference', MS.performanceOf({ stats: 'All-American' }).signals.map((s) => s.key).join(',') === 'all_american');
  ok('  "not a starter" is not a starter', MS.performanceOf({ stats: 'not a starter yet' }).points === 0);
  ok('  capped at 20', MS.performanceOf({ stats: 'All-American, SEC Player of the Year, five-star, team captain, starter, 2,000 yards, national champion, draft prospect' }).points === 20);
  const p0 = MS.performanceOf({});
  ok('no stats, awards or notes: 0 at confidence 0', p0.points === 0 && p0.confidence === 0 && p0.missing.includes('performance'), p0);
  const pq = MS.performanceOf({ notes: 'Loves fishing and coffee' });
  ok('text that names nothing measurable: 0 at half confidence (we read it; it did not say)', pq.points === 0 && pq.confidence === 0.5, pq);

  // ── 4. MEDIA ──────────────────────────────────────────────────────────────
  OUT.push('', '-- media --');
  const m0 = MS.mediaOf(null, NOW);
  ok('not searched yet: 0 at confidence 0', m0.points === 0 && m0.confidence === 0 && m0.missing.includes('news mentions'));
  const m1 = MS.mediaOf({ searchedAt: '2026-10-14', mentions: [
    { url: 'https://www.espn.com/a', title: 'A', kind: 'news', published_on: '2026-10-01' },
    { url: 'https://localpaper.com/b', title: 'B', kind: 'news', published_on: '2026-09-20' },
    { url: 'https://rolltide.com/c', title: 'C', kind: 'school', published_on: '2026-09-15' },
    { url: 'https://old.com/d', title: 'D', kind: 'news', published_on: '2026-03-01' },
  ] }, NOW);
  ok('two independent mentions (5) + a national outlet (1) + a school release (0.5); the March one is outside 90 days',
    m1.points === 6.5 && m1.mentions === 2 && m1.national === 1 && m1.confidence === 0.8, m1);
  const mf = MS.mediaOf({ searchedAt: '2026-10-14', fault: 'timeout', mentions: [] }, NOW);
  ok('a search that failed on our side is unknown, not zero news', mf.confidence === 0 && /failed on our side/.test(mf.reasons[0]), mf);

  // ── 5. MARKET ─────────────────────────────────────────────────────────────
  OUT.push('', '-- market --');
  const r0 = rec({ school: 'University of Alabama' });
  const mk = MS.marketOf({ rec: r0, cityPop: { pop: 99600, place: 'Tuscaloosa city, Alabama', source: '2020 Census' } });
  ok('city population on a log scale (Tuscaloosa ~100k -> 6), from the 2020 Census', mk.points === 6 && mk.confidence === 0.9 && /99,600 people/.test(mk.reasons[0]), mk);
  ok('  10,000 -> 0, ~3.2 million -> 15', MS.marketPoints(10000) === 0 && MS.marketPoints(3200000) === 15);
  const mp = MS.marketOf({ rec: r0, cityPop: null, pool: { usable: 200, rows: 260 } });
  ok('no population: the local pool depth, at low confidence, and says so', mp.points > 0 && mp.confidence === 0.4 && /low confidence/.test(mp.reasons[0]), mp);
  const mn = MS.marketOf({ rec: rec({}), cityPop: null, pool: null });
  ok('no school city: 0 at confidence 0', mn.points === 0 && mn.confidence === 0);
  ok('Census place names: "Athens-Clarke County unified government (balance), Georgia" is Athens',
    MS.placeKeys('Athens-Clarke County unified government (balance), Georgia').includes('athens') && MS.placeKeys('Tuscaloosa city, Alabama')[0] === 'tuscaloosa');

  // ── 6. THE SCORE AND THE TIER ─────────────────────────────────────────────
  OUT.push('', '-- the score and the tier --');
  ok('tiers: 75+ National, 55+ Regional, 35+ Rising, else Local Star',
    MS.tierFor(75).key === 'national' && MS.tierFor(74).key === 'regional' && MS.tierFor(55).key === 'regional' && MS.tierFor(54).key === 'rising'
    && MS.tierFor(35).key === 'rising' && MS.tierFor(34).key === 'local_star' && MS.tierFor(0).key === 'local_star');
  const star = scoreOf({ name: 'Star QB', school: 'University of Alabama', sport: 'Football', instagram: 500000, engagement: 6.1,
    reachSource: 'agent', reachAsOf: '2026-09-01', stats: 'All-American, 3,800 yards, team captain' },
  { news: { searchedAt: '2026-10-14', mentions: Array.from({ length: 9 }, (_, i) => ({ url: `https://espn.com/${i}`, title: 'x', kind: 'news', published_on: '2026-10-01' })) },
    cityPop: { pop: 99600, place: 'Tuscaloosa city, Alabama' } });
  ok('a Power 4 All-American QB with 500k followers and national coverage is National', star.tier === 'national' && star.score >= 75, { score: star.score, tier: star.tier });
  ok('  the reasons say what drove it, biggest part first', /reach/.test(star.reasons[0]) && star.reasons.some((r) => /Power 4/.test(r)) && star.reasons.some((r) => /All-American/.test(r)), star.reasons);
  const d2 = scoreOf({ name: 'D2 Keeper', school: 'Bentley University', sport: 'Soccer', instagram: 3000, engagement: 2 });
  ok('a Division II soccer player with 3,000 followers is a Local Star', d2.tier === 'local_star', { score: d2.score, tier: d2.tier });
  const blank = scoreOf({ name: 'Blank' });
  ok('an athlete with nothing on file scores 0 at confidence 0, a Local Star, every part listed missing',
    blank.score === 0 && blank.confidence === 0 && blank.tier === 'local_star' && blank.missing.length >= 5, blank);
  const half = scoreOf({ name: 'Half', school: 'Texas Tech University', sport: 'Softball' });
  const full = scoreOf({ name: 'Full', school: 'Texas Tech University', sport: 'Softball', instagram: 8000, engagement: 5 });
  ok('missing data lowers the score and the confidence, never raises either', half.score < full.score && half.confidence < full.confidence, [half.score, full.score, half.confidence, full.confidence]);
  ok('confidence is the share of the 100 backed by data', Math.abs(full.confidence - Object.values(full.components).reduce((s, c) => s + c.max * c.confidence, 0) / 100) < 0.011, full.confidence);
  const printed = MS.format({ ...star, name: 'Star QB' });
  ok('printed: the score, the tier, each part and what drove it', /^Star QB: \d+\/100, National \(confidence \d+%\)/.test(printed)
    && /Level and sport/.test(printed) && /Social reach/.test(printed) && /What drove it:/.test(printed), printed);

  // ── 7. NEWS: ONLY WHAT THE SEARCH RETURNED, NAMING THE ATHLETE ────────────
  OUT.push('', '-- the news search --');
  const msg = { content: [
    { type: 'web_search_tool_result', content: [
      { type: 'web_search_result', url: 'https://www.al.com/story-1', title: 'Jalen Fake leads Tide past Vols' },
      { type: 'web_search_result', url: 'https://rolltide.com/news/2', title: 'Football notes' },
      { type: 'web_search_result', url: 'https://www.espn.com/old', title: 'Jalen Fake commits' },
    ] },
    { type: 'text', text: JSON.stringify({ articles: [
      { url: 'https://www.al.com/story-1', title: 'x', date: '2026-10-05', kind: 'news' },
      { url: 'https://rolltide.com/news/2', title: 'x', date: '2026-10-02', kind: 'school' },
      { url: 'https://www.espn.com/old', title: 'x', date: '2025-12-01', kind: 'news' },
      { url: 'https://made-up.com/never-searched', title: 'Jalen Fake', date: '2026-10-07', kind: 'news' },
    ] }), citations: [{ type: 'web_search_result_location', url: 'https://rolltide.com/news/2', cited_text: 'Fake ran for 140 yards.' }] },
  ] };
  const pn = MS.parseNews(msg, { name: 'Jalen Fake', school: 'Alabama', now: NOW });
  ok('kept: the article the search returned that names him, and the school release whose quoted text names him',
    pn.mentions.length === 2 && pn.mentions.some((m) => /al\.com/.test(m.url) && m.kind === 'news') && pn.mentions.some((m) => /rolltide/.test(m.url) && m.kind === 'school'), pn);
  ok('  dropped: a URL the search never returned, and one outside 90 days', pn.dropped.some((d) => /made-up/.test(d.url) && /not among/.test(d.why)) && pn.dropped.some((d) => /old/.test(d.url) && /90 days/.test(d.why)), pn.dropped);

  // ── 8. STORED WEEKLY, WITH THE REASONS ────────────────────────────────────
  OUT.push('', '-- stored weekly --');
  const P = store.pool;
  const AG = 'msc-agent';
  await MS.ensureTables(P);
  const clean = async () => {
    await P.query(`DELETE FROM athlete_market_scores WHERE athlete_id LIKE 'msc-%'`);
    await P.query(`DELETE FROM athlete_news_mentions WHERE athlete_id LIKE 'msc-%'`);
    await P.query(`DELETE FROM athlete_news_searches WHERE athlete_id LIKE 'msc-%'`);
    await P.query(`DELETE FROM athletes WHERE agent_id = $1`, [AG]);
    await P.query(`DELETE FROM census_place_pop WHERE state = 'UT'`);
    await P.query(`DELETE FROM census_state_fetch WHERE state = 'UT'`);
  };
  await clean();
  const data = { name: 'Msc Aggie', school: 'Utah State University', sport: 'Football', instagram: 12000, engagement: 3.5 };
  await P.query(`INSERT INTO athletes (id, agent_id, data) VALUES ('msc-1', $1, $2::jsonb)`, [AG, JSON.stringify(data)]);
  // The Census, stubbed: one state's places.
  let censusCalls = 0;
  const fetchImpl = async (url) => {
    censusCalls++;
    return { ok: /state:49/.test(url), status: 200, json: async () => [['NAME', 'P1_001N', 'state', 'place'], ['Logan city, Utah', '52778', '49', '45860'], ['Provo city, Utah', '115162', '49', '62470']] };
  };
  let searches = 0;
  const webSearch = async () => { searches++; return { content: [
    { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://hjnews.com/1', title: 'Aggie carries Utah State' }] },
    { type: 'text', text: '{"articles":[{"url":"https://hjnews.com/1","date":"2026-10-03","kind":"news"}]}' },
  ] }; };
  const row = (await P.query(`SELECT id, agent_id, data, instagram_followers, tiktok_followers, twitter_followers, athlete_type FROM athletes WHERE id = 'msc-1'`)).rows[0];
  const s1 = await MS.computeFor(P, row, { search: true, webSearch, fetchImpl, now: NOW, ig: null });
  ok('the week: one news search, the city from the Census, the score stored with its reasons', searches === 1 && censusCalls === 1
    && s1.components.market.population === 52778 && s1.components.media.mentions === 1, { searches, censusCalls, market: s1.components.market, media: s1.components.media });
  const last = await MS.latestFor(P, 'msc-1');
  ok('  latestFor reads it back: score, tier, confidence, components, reasons', last && last.score === s1.score && last.tier === s1.tier
    && Array.isArray(last.reasons) && last.reasons.length > 3 && last.components.levelSport.level === 'g5', last);
  const s2 = await MS.computeFor(P, row, { search: true, webSearch, fetchImpl, now: new Date(NOW.getTime() + 2 * 86400000), ig: null });
  ok('  two days later: no second news search, no second Census load (both cached)', searches === 1 && censusCalls === 1 && s2.score === s1.score, { searches, censusCalls });
  const f1 = await MS.forAthlete(P, 'msc-1', { now: new Date(NOW.getTime() + 3 * 86400000) });
  ok('the nightly read: the stored score while under a week old', f1.score === s1.score && f1.tier === s1.tier);
  const before = (await P.query(`SELECT COUNT(*)::int n FROM athlete_market_scores WHERE athlete_id = 'msc-1'`)).rows[0].n;
  await P.query(`UPDATE athlete_market_scores SET computed_at = NOW() - interval '8 days' WHERE athlete_id = 'msc-1'`);
  const rs = await MS.recomputeIfStale(P, { webSearch, fetchImpl, now: new Date(), ig: null });
  const after = (await P.query(`SELECT COUNT(*)::int n FROM athlete_market_scores WHERE athlete_id = 'msc-1'`)).rows[0].n;
  ok('recomputeIfStale: a score over a week old is recomputed and a history row added', rs.done >= 1 && after === before + 1, { rs, before, after });
  const noState = await MS.cityPopulation(P, 'Nowhere', null);
  ok('a city with no state is not looked up', noState === null);

  // ── 9. THE WIRING ─────────────────────────────────────────────────────────
  OUT.push('', '-- the wiring --');
  const IDX = fs.readFileSync(REPO + 'server/index.js', 'utf8');
  ok('recomputed weekly, only under MARKET_MIX_ON', /if \(MS\.ON\(\)\) MS\.recomputeIfStale\(store\.pool\)/.test(IDX));
  delete process.env.MARKET_MIX_ON;
  ok('MARKET_MIX_ON is off by default', MS.ON() === false);
  const D = require(REPO + 'server/scripts/admin/market-score.js');
  ok('the admin script market-score: one descriptor, read-only unless save=1', D.name === 'market-score' && D.args({}).length === 0
    && D.args({ save: '1', search: '1', limit: '20' }).join(' ') === '--limit 20 --save --search' && fs.existsSync(REPO + D.file));
  await clean();
}

main().catch((e) => { F++; OUT.push('FAIL threw: ' + (e && e.stack || e)); }).finally(async () => {
  const pass = OUT.filter((l) => l.startsWith('PASS')).length;
  console.log(OUT.join('\n'));
  console.log(`\n${pass}/${pass + F} passed`);
  try { await store.pool.end(); } catch (_) {}
  process.exit(F ? 1 : 0);
});
