'use strict';
// Runs from a checkout on any machine, offline: the roster feeds are fixtures
// (proRosterFeeds._setFetchForTests) and the web stage is a stand-in
// (athleteLookup._setSearchLoopForTests). No network, no key, no database
// (the cache is skipped with force).
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/prolookup.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
const fs = require('fs');

// ── THE PRO LOOKUP: THE FEEDS ARE READ WITHOUT A TEAM, THE WEB IS A FALLBACK
//    WITH EVIDENCE, AND THE TRACE SAYS WHAT HAPPENED ───────────────────────
//
// "Bo Nix", Pro, Football, no team, came back "No verified athlete found".
// The feeds were never read: espnLeague gave up with "no team given, so the
// roster feed was not read", and the web stage's answer was invisible. Now a
// league is searched roster by roster when no team is given, a nickname
// resolves to the club, the web fallback is accepted only when a search
// result names the player, the team and the position, and every lookup
// carries a trace of which sources were asked and what each said.

const Feeds = require(REPO + 'server/services/proRosterFeeds.js');
const AL = require(REPO + 'server/services/athleteLookup.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

// ── THE FEEDS, AS FIXTURES ──────────────────────────────────────────────────
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const team = (id, location, name, abbreviation) => ({ team: { id: String(id), location, name, displayName: `${location} ${name}`, abbreviation } });
const NFL_TEAMS = [team(7, 'Denver', 'Broncos', 'DEN'), team(12, 'Kansas City', 'Chiefs', 'KC'), team(2, 'Buffalo', 'Bills', 'BUF'), team(16, 'Minnesota', 'Vikings', 'MIN')];
const NBA_TEAMS = [team(7, 'Denver', 'Nuggets', 'DEN'), team(2, 'Boston', 'Celtics', 'BOS'), team(25, 'Oklahoma City', 'Thunder', 'OKC')];
const player = (fullName, pos, jersey, extra) => Object.assign({ fullName, position: { abbreviation: pos }, jersey, displayHeight: '6\' 2"', displayWeight: '214 lbs', birthPlace: { city: 'Pinson', state: 'AL' }, college: { name: 'Oregon' }, links: [{ rel: ['playercard'], href: 'https://www.espn.com/player/' + fullName.toLowerCase().replace(/\s+/g, '-') }] }, extra || {});
const ROSTERS = {
  [`${ESPN}/football/nfl/teams/7/roster`]: { athletes: [{ items: [player('Bo Nix', 'QB', '10'), player('Courtland Sutton', 'WR', '14')] }] },
  [`${ESPN}/football/nfl/teams/12/roster`]: { athletes: [{ items: [player('Patrick Mahomes', 'QB', '15')] }] },
  [`${ESPN}/football/nfl/teams/2/roster`]: { athletes: [{ items: [player('Josh Allen', 'QB', '17')] }] },
  [`${ESPN}/football/nfl/teams/16/roster`]: { athletes: [{ items: [player('Justin Jefferson', 'WR', '18')] }] },
  [`${ESPN}/basketball/nba/teams/7/roster`]: { athletes: [player('Nikola Jokic', 'C', '15'), player('Jamal Murray', 'PG', '27')] },
  [`${ESPN}/basketball/nba/teams/2/roster`]: { athletes: [player('Jayson Tatum', 'SF', '0')] },
  [`${ESPN}/basketball/nba/teams/25/roster`]: { athletes: [player('Shai Gilgeous-Alexander', 'PG', '2')] },
};
const feedCalls = [];
Feeds._setFetchForTests(async (url) => {
  feedCalls.push(url);
  if (url.startsWith(`${ESPN}/football/nfl/teams?`)) return { sports: [{ leagues: [{ teams: NFL_TEAMS }] }] };
  if (url.startsWith(`${ESPN}/basketball/nba/teams?`)) return { sports: [{ leagues: [{ teams: NBA_TEAMS }] }] };
  if (url.startsWith(`${ESPN}/football/ufl/teams?`) || url.startsWith(`${ESPN}/football/cfl/teams?`)) return { sports: [{ leagues: [{ teams: [] }] }] };
  if (url.startsWith(`${ESPN}/basketball/wnba/teams?`)) return { sports: [{ leagues: [{ teams: [] }] }] };
  if (ROSTERS[url]) return ROSTERS[url];
  if (/statsapi\.mlb\.com\/api\/v1\/people\/search/.test(url)) {
    const q = decodeURIComponent(url.match(/names=([^&]+)/)[1]);
    if (/judge/i.test(q)) return { people: [{ id: 592450, fullName: 'Aaron Judge', primaryNumber: '99', primaryPosition: { abbreviation: 'RF' }, currentTeam: { name: 'New York Yankees', locationName: 'New York', sport: { id: 1 } }, birthCity: 'Linden', birthStateProvince: 'CA', height: '6\' 7"', weight: 282 }] };
    return { people: [] };
  }
  if (/stats\.nba\.com|hockeytech/.test(url)) throw new Error('HTTP 403');
  throw new Error('HTTP 404');
});

// ── THE WEB STAGE STAND-IN ──────────────────────────────────────────────────
const loopCalls = [];
let WEB = {};
AL._setSearchLoopForTests(async (o) => {
  loopCalls.push(o.prompt);
  const nm = (o.prompt.match(/^Name: (.+)$/m) || [])[1];
  const w = WEB[nm] || { citations: [], athletes: [], results: [] };
  return { text: JSON.stringify({ found: w.athletes.length > 0, athletes: w.athletes, searchNote: w.searchNote || null }), citations: w.citations, results: w.results || [], searches: 2, usage: { inputTokens: 800, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 2 } };
});

(async () => {
  OUT.push('-- 1. what happens on "Bo Nix", Pro, Football, no team --');
  feedCalls.length = 0; loopCalls.length = 0;
  const nix = await AL.resolveAthlete(null, { name: 'Bo Nix', sport: 'football', athleteType: 'pro', team: '' }, { force: true });
  ok('the NFL is searched roster by roster when no team is given, and he is found', nix.found === true && nix.candidates[0].name === 'Bo Nix' && nix.candidates[0].team === 'Denver Broncos' && nix.candidates[0].position === 'QB', nix.candidates[0]);
  ok('  every NFL roster was read (four teams in the fixture), once each', feedCalls.filter((u) => /football\/nfl\/teams\/\d+\/roster/.test(u)).length === 4, feedCalls);
  ok('  the trace says which sources were asked and what each answered', Array.isArray(nix.trace) && nix.trace.some((t) => /NFL: 4 rosters, \d+ players read, 1 match\(es\) for "Bo Nix"/.test(t)) && nix.trace.some((t) => /^web search:/.test(t)), nix.trace);
  ok('  the fields are sourced to the roster page', nix.candidates[0].sources && /espn/.test(nix.candidates[0].sources.team) && /espn/.test(nix.candidates[0].sources.position) && nix.candidates[0].sourceLabel === 'ESPN NFL roster');
  ok('  every trace line is logged', /for \(const line of trace\) console\.log\(`\[lookup\] \$\{level\} "\$\{name\}": \$\{line\}`\)/.test(src('server/services/athleteLookup.js')));

  OUT.push('', '-- 2. the team as a nickname, and the roster cache --');
  feedCalls.length = 0;
  const nick = await AL.resolveAthlete(null, { name: 'Bo Nix', sport: 'football', athleteType: 'pro', team: 'Broncos' }, { force: true });
  ok('"Broncos" resolves to the Denver Broncos and only that roster is read', nick.found === true && nick.candidates[0].team === 'Denver Broncos' && feedCalls.filter((u) => /nfl\/teams\/\d+\/roster/.test(u)).length === 0 && nick.trace.some((t) => /Denver Broncos roster read, 1 match/.test(t)), { calls: feedCalls, trace: nick.trace });
  ok('  (no roster fetch this time: the rosters read a moment ago are cached for an hour)', /ROSTER_CACHE_MS = 60 \* 60 \* 1000/.test(src('server/services/proRosterFeeds.js')));
  ok('a wrong team is said plainly', (await Feeds.searchFeeds({ name: 'Bo Nix', sport: 'football', team: 'Wichita Wind Surge' })).notes.some((n) => /NFL: no team matches "Wichita Wind Surge"/.test(n)));

  OUT.push('', '-- 3. NBA and MLB by name and team --');
  const jok = await AL.resolveAthlete(null, { name: 'Nikola Jokic', sport: 'basketball', athleteType: 'pro', team: 'Denver Nuggets' }, { force: true });
  ok('NBA: Nikola Jokic, Denver Nuggets, C, from the ESPN NBA roster', jok.found && jok.candidates[0].team === 'Denver Nuggets' && jok.candidates[0].position === 'C' && jok.candidates[0].sourceLabel === 'ESPN NBA roster', jok.candidates[0]);
  const tat = await AL.resolveAthlete(null, { name: 'Jayson Tatum', sport: 'basketball', athleteType: 'pro' }, { force: true });
  ok('  and with no team, the whole league', tat.found && tat.candidates[0].team === 'Boston Celtics', tat.trace);
  const judge = await AL.resolveAthlete(null, { name: 'Aaron Judge', sport: 'baseball', athleteType: 'pro', team: 'Yankees' }, { force: true });
  ok('MLB: Aaron Judge, New York Yankees, RF, from the MLB StatsAPI', judge.found && judge.candidates[0].team === 'New York Yankees' && judge.candidates[0].position === 'RF' && /MLB StatsAPI/.test(judge.candidates[0].sourceLabel), judge.candidates[0]);

  OUT.push('', '-- 4. the web fallback: accepted only with evidence --');
  WEB = {
    'Kyle Trask': { citations: ['https://www.nfl.com/players/kyle-trask/'], athletes: [{ name: 'Kyle Trask', team: 'Tampa Bay Buccaneers', position: 'QB', sport: 'football', sources: { profile: 'https://www.nfl.com/players/kyle-trask/' }, confidence: 80 }],
      results: [{ title: 'Kyle Trask - Tampa Bay Buccaneers Quarterback', url: 'https://www.nfl.com/players/kyle-trask/', snippet: 'Kyle Trask, QB for the Buccaneers, 2025 season stats.' }] },
    'Made Upson': { citations: ['https://example.com/made-upson'], athletes: [{ name: 'Made Upson', team: 'Denver Broncos', position: 'QB', sport: 'football', sources: { profile: 'https://example.com/made-upson' }, confidence: 80 }],
      results: [{ title: 'Made Upson', url: 'https://example.com/made-upson', snippet: 'A page that names the person and nothing about a team or a position.' }] },
    'Nobody Real': { citations: [], athletes: [], results: [], searchNote: 'no page names a pro by this name' },
  };
  const trask = await AL.resolveAthlete(null, { name: 'Kyle Trask', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('a player the feeds missed is found on the web when a result names the player, the team and the position', trask.found && trask.candidates[0].team === 'Tampa Bay Buccaneers' && trask.candidates[0].position === 'QB' && trask.candidates[0].sources.team === 'https://www.nfl.com/players/kyle-trask/' && trask.trace.some((t) => /web candidate "Kyle Trask" accepted: https:\/\/www\.nfl\.com\/players\/kyle-trask\/ names the player, Tampa Bay Buccaneers and QB/.test(t)), { c: trask.candidates[0], trace: trask.trace });
  ok('  the trace shows the feeds missed and the web answered', trask.trace.some((t) => /NFL: 4 rosters/.test(t) && /nobody named like "Kyle Trask"/.test(t)) && trask.trace.some((t) => /web search: 2 search\(es\), 1 result\(s\) seen, model returned 1 athlete\(s\), 1 kept/.test(t)), trask.trace);
  const made = await AL.resolveAthlete(null, { name: 'Made Upson', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('a web candidate with no result naming team and position together is dropped, and the trace says so', made.found === false && made.trace.some((t) => /web candidate "Made Upson" dropped: no search result names the player, the team \(Denver Broncos\) and the position \(QB\) together/.test(t)), made.trace);
  ok('  and the message carries the trace, so "No verified athlete found" is never the whole story', /No verified athlete found/.test(made.message) && /Checked: roster feeds/.test(made.message) && /web candidate "Made Upson" dropped/.test(made.message), made.message);
  const nobody = await AL.resolveAthlete(null, { name: 'Nobody Real', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('nobody anywhere: the trace names every league read and the empty web answer', nobody.found === false && nobody.trace.some((t) => /NFL: 4 rosters/.test(t)) && nobody.trace.some((t) => /model returned 0 athlete\(s\)/.test(t)), nobody.trace);
  ok('proWebEvidence reads positions either way: "QB" and "quarterback", "C" and "center", "SP" and "pitcher"', !!AL.proWebEvidence({ name: 'Bo Nix', team: 'Denver Broncos', position: 'QB' }, [{ title: 'Bo Nix, Broncos quarterback', url: 'u', snippet: '' }]) && !!AL.proWebEvidence({ name: 'Nikola Jokic', team: 'Denver Nuggets', position: 'C' }, [{ title: 'Jokic', url: 'u', snippet: 'Nuggets center' }]) && !!AL.proWebEvidence({ name: 'Paul Skenes', team: 'Pittsburgh Pirates', position: 'SP' }, [{ title: 'Skenes', url: 'u', snippet: 'Pirates pitcher' }]) && !AL.proWebEvidence({ name: 'Bo Nix', team: 'Denver Broncos', position: 'QB' }, [{ title: 'Bo Nix', url: 'u', snippet: 'a quarterback' }]));

  OUT.push('', '-- 5. the form --');
  const html = src('public/index.html');
  ok('the hint under the name changes for a pro: team or city, not school and sport; and the parent email is hidden', /Enter their team or city for best results/.test(html) && /show\('a_parent_wrap', !pro\)/.test(html) && /id="a_parent_wrap"/.test(html) && /id="a_lookup_hint"/.test(html));
  ok('the hit-rate script exists with ten NFL, ten NBA and ten MLB players and reports per league', (() => { const s = src('scripts/lookup-pro-hitrate.js'); return /NFL: \[/.test(s) && /NBA: \[/.test(s) && /MLB: \[/.test(s) && ['Bo Nix', 'Patrick Mahomes', 'Nikola Jokic', 'Stephen Curry', 'Aaron Judge', 'Shohei Ohtani'].every((n) => s.includes(n)) && (s.match(/\['[^\]]*'\]/g) || []).length >= 30 && /HIT RATE BY LEAGUE/.test(s) && /below the 8 of 10 bar/.test(s); })());

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('prolookup: FAILED', e); process.exit(1); });
