'use strict';
// Runs from a checkout on any machine, offline: the one production feed (MLB
// StatsAPI) is a fixture (proRosterFeeds._setFetchForTests) and the web stage
// is a stand-in (athleteLookup._setSearchLoopForTests). No network, no key,
// no database (the cache is skipped with force).
//
//   node tests/run.js              every suite, against the committed baseline
//   node tests/prolookup.js        just this one
const _tp = require('path');
const REPO = _tp.join(__dirname, '..') + _tp.sep;
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test-key-never-used';
process.env.PGHOST = process.env.PGHOST || '/tmp';
process.env.PGPORT = process.env.PGPORT || '55432';
delete process.env.ROSTER_FEEDS;
const fs = require('fs');

// ── THE PRO LOOKUP FROM PRODUCTION: MLB STATSAPI IS THE ONLY FEED, THE WEB IS
//    THE PRIMARY PATH FOR EVERY OTHER LEAGUE, AND THE TRACE SAYS WHAT HAPPENED
//
// The probe from Railway: ESPN answers 403 on every endpoint, the NHL API
// redirects, HockeyTech denies the key, the G League stats host times out.
// Only MLB StatsAPI answers. So the lookup no longer asks the others (no
// request, no delay), searches the web first for NFL, NBA, NHL, MLS, WNBA,
// the G League, AHL, ECHL, CFL, UFL and USL, prefers Wikipedia and the
// team's official roster page, and accepts a result only when a source names
// the player, the team and the position together. Sport, position, team,
// city and jersey come off the page; the city falls back to the team table.

const Feeds = require(REPO + 'server/services/proRosterFeeds.js');
const AL = require(REPO + 'server/services/athleteLookup.js');

let OUT = [], F = 0;
const ok = (n, c, g) => { if (c) OUT.push('PASS ' + n); else { F++; OUT.push('FAIL ' + n + (g !== undefined ? '  got=' + JSON.stringify(g) : '')); } };
const src = (p) => fs.readFileSync(REPO + p, 'utf8');

// ── THE FEEDS: only StatsAPI is reachable; anything else asked is a bug ─────
const feedCalls = [];
Feeds._setFetchForTests(async (url) => {
  feedCalls.push(url);
  if (/statsapi\.mlb\.com\/api\/v1\/people\/search/.test(url)) {
    const q = decodeURIComponent(url.match(/names=([^&]+)/)[1]);
    if (/judge/i.test(q)) return { people: [{ id: 592450, fullName: 'Aaron Judge', primaryNumber: '99', primaryPosition: { abbreviation: 'RF' }, currentTeam: { name: 'New York Yankees', locationName: 'New York', sport: { id: 1 } }, birthCity: 'Linden', birthStateProvince: 'CA', height: '6\' 7"', weight: 282 }] };
    if (/minor/i.test(q)) return { people: [{ id: 1, fullName: 'Minor Leaguer', primaryNumber: '7', primaryPosition: { abbreviation: 'SS' }, currentTeam: { name: 'Somerset Patriots', locationName: 'Somerset', sport: { id: 12 } } }] };
    return { people: [] };
  }
  throw new Error('a feed other than MLB StatsAPI was asked: ' + url);
});

// ── THE WEB STAGE STAND-IN ──────────────────────────────────────────────────
const loopCalls = [];
const WEB = {
  'Bo Nix': { citations: ['https://en.wikipedia.org/wiki/Bo_Nix', 'https://www.denverbroncos.com/team/players-roster/bo-nix/'],
    athletes: [{ name: 'Bo Nix', team: 'Denver Broncos', league: 'NFL', sport: 'football', position: 'QB', jersey: '10', sources: { profile: 'https://en.wikipedia.org/wiki/Bo_Nix', jersey: 'https://www.denverbroncos.com/team/players-roster/bo-nix/' }, sourceLabel: 'Wikipedia', confidence: 90 }],
    results: [{ title: 'Bo Nix - Wikipedia', url: 'https://en.wikipedia.org/wiki/Bo_Nix', snippet: 'Bo Nix is an American football quarterback for the Denver Broncos of the National Football League.' },
      { title: 'Bo Nix | Denver Broncos roster', url: 'https://www.denverbroncos.com/team/players-roster/bo-nix/', snippet: 'QB #10' }] },
  'Nikola Jokic': { citations: ['https://www.nba.com/player/203999/nikola-jokic'],
    athletes: [{ name: 'Nikola Jokić', team: 'Denver Nuggets', sport: 'basketball', position: 'C', jersey: '15', city: 'Denver, CO', sources: { profile: 'https://www.nba.com/player/203999/nikola-jokic' }, sourceLabel: 'NBA.com', confidence: 92 }],
    results: [{ title: 'Nikola Jokić | Denver Nuggets | NBA.com', url: 'https://www.nba.com/player/203999/nikola-jokic', snippet: 'Center, #15, Denver Nuggets.' }] },
  'Made Upson': { citations: ['https://example.com/made-upson'], athletes: [{ name: 'Made Upson', team: 'Denver Broncos', position: 'QB', sport: 'football', sources: { profile: 'https://example.com/made-upson' }, confidence: 80 }],
    results: [{ title: 'Made Upson', url: 'https://example.com/made-upson', snippet: 'A page that names the person and nothing about a team or a position.' }] },
  'Nobody Real': { citations: [], athletes: [], results: [], searchNote: 'no page names a pro by this name' },
};
AL._setSearchLoopForTests(async (o) => {
  loopCalls.push(o.prompt);
  const nm = (o.prompt.match(/^Name: (.+)$/m) || [])[1];
  const w = WEB[nm] || { citations: [], athletes: [], results: [] };
  return { text: JSON.stringify({ found: w.athletes.length > 0, athletes: w.athletes, searchNote: w.searchNote || null }), citations: w.citations, results: w.results || [], searches: 3, usage: { inputTokens: 800, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0, webSearches: 3 } };
});

(async () => {
  OUT.push('-- 1. which feeds run from production --');
  ok('MLB StatsAPI is the only feed on by default', JSON.stringify(Feeds.enabledFeeds()) === '["MLB"]' && JSON.stringify(Feeds.DEFAULT_FEEDS) === '["MLB"]');
  ok('  the NFL, NBA, WNBA, MLS, CFL, UFL and USL need ESPN, hockey needs the NHL API or HockeyTech, the G League its stats host: none of them run', ['NFL', 'NBA', 'WNBA', 'MLS', 'CFL', 'UFL', 'USL Championship'].every((l) => JSON.stringify(Feeds.feedsFor(l)) === '["ESPN"]') && JSON.stringify(Feeds.feedsFor('AHL')) === '["HOCKEYTECH"]' && JSON.stringify(Feeds.feedsFor('G League')) === '["GLEAGUE"]' && Feeds.feedsFor('NHL').includes('NHL'));
  process.env.ROSTER_FEEDS = 'MLB, espn';
  ok('  ROSTER_FEEDS re-enables a feed if it ever answers from production', JSON.stringify(Feeds.enabledFeeds()) === '["MLB","ESPN"]');
  delete process.env.ROSTER_FEEDS;
  const nfl = await Feeds.searchFeeds({ name: 'Bo Nix', sport: 'football', team: 'Denver Broncos' });
  ok('a football lookup asks no feed at all and says why', nfl.candidates.length === 0 && nfl.feedsTried.length === 0 && nfl.feedsSkipped.join(',') === 'NFL,UFL,CFL' && nfl.notes.some((n) => /NFL, UFL, CFL: roster feed not run \(not reachable from production; ESPN 403, NHL redirect, HockeyTech denied, G League timeout\); web search/.test(n)) && feedCalls.length === 0, { notes: nfl.notes, calls: feedCalls });
  const hky = await Feeds.searchFeeds({ name: 'Nathan MacKinnon', sport: 'hockey' });
  ok('  hockey and basketball too', hky.feedsTried.length === 0 && hky.feedsSkipped.join(',') === 'NHL,AHL,ECHL' && (await Feeds.searchFeeds({ name: 'X', sport: 'basketball' })).feedsSkipped.join(',') === 'NBA,WNBA,G League' && feedCalls.length === 0);

  OUT.push('', '-- 2. MLB: StatsAPI, majors and minors --');
  const judge = await AL.resolveAthlete(null, { name: 'Aaron Judge', sport: 'baseball', athleteType: 'pro', team: 'Yankees' }, { force: true });
  ok('Aaron Judge: New York Yankees, RF, #99, from the MLB StatsAPI', judge.found && judge.candidates[0].team === 'New York Yankees' && judge.candidates[0].position === 'RF' && judge.candidates[0].jersey === '99' && /MLB StatsAPI/.test(judge.candidates[0].sourceLabel), judge.candidates[0]);
  ok('  the trace says the feed answered', judge.trace.some((t) => /roster feeds/.test(t) && /1 candidate/.test(t)), judge.trace);
  const minor = await AL.resolveAthlete(null, { name: 'Minor Leaguer', sport: 'baseball', athleteType: 'pro' }, { force: true });
  ok('a minor leaguer comes back with the level (Double-A) and the club', minor.found && minor.candidates[0].team === 'Somerset Patriots' && /Double-A/.test(minor.candidates[0].sourceLabel), minor.candidates[0]);

  OUT.push('', '-- 3. NFL and NBA: the web first, with evidence --');
  feedCalls.length = 0; loopCalls.length = 0;
  const nix = await AL.resolveAthlete(null, { name: 'Bo Nix', sport: 'football', athleteType: 'pro', team: '' }, { force: true });
  ok('Bo Nix, Pro, Football, no team: found on the web with team, position, jersey, sport', nix.found === true && nix.candidates[0].team === 'Denver Broncos' && nix.candidates[0].position === 'QB' && nix.candidates[0].jersey === '10' && nix.candidates[0].sport === 'football', nix.candidates[0]);
  ok('  the city comes from the team table when no page said it', nix.candidates[0].city === 'Denver, CO' && nix.candidates[0].sources.city === 'team-table');
  ok('  accepted because a result names the player, the team and the position (Wikipedia)', nix.trace.some((t) => /web candidate "Bo Nix" accepted: https:\/\/en\.wikipedia\.org\/wiki\/Bo_Nix names the player, Denver Broncos and QB/.test(t)), nix.trace);
  ok('  no feed was asked, and the trace says the feeds were not run', feedCalls.length === 0 && nix.trace.some((t) => /roster feed not run/.test(t)), { calls: feedCalls, trace: nix.trace });
  ok('  the prompt prefers Wikipedia and the official roster page and asks for sport, position, team, city and jersey', /"Bo Nix" wikipedia/.test(loopCalls[0]) && /"Bo Nix" roster/.test(loopCalls[0]) && /PREFER Wikipedia and the team's official roster page/.test(loopCalls[0]) && /nfl\.com, nba\.com, mlb\.com, nhl\.com, mlssoccer\.com, wnba\.com, gleague\.nba\.com, theahl\.com, echl\.com, cfl\.ca, theufl\.com, uslchampionship\.com/.test(loopCalls[0]) && /Report the sport, the position, the team, the team's home city as "City, ST", and the jersey number/.test(loopCalls[0]), loopCalls[0]);
  const jok = await AL.resolveAthlete(null, { name: 'Nikola Jokic', sport: 'basketball', athleteType: 'pro', team: 'Denver Nuggets' }, { force: true });
  ok('NBA: Nikola Jokić, Denver Nuggets, C, #15, from NBA.com, with the city the page gave', jok.found && jok.candidates[0].team === 'Denver Nuggets' && jok.candidates[0].position === 'C' && jok.candidates[0].jersey === '15' && jok.candidates[0].city === 'Denver, CO' && jok.candidates[0].sources.city !== 'team-table', jok.candidates[0]);
  ok('  with the team in the query', /"Nikola Jokic" Denver Nuggets wikipedia/.test(loopCalls[loopCalls.length - 1]));

  OUT.push('', '-- 4. no evidence, no candidate; nothing, the trace --');
  const made = await AL.resolveAthlete(null, { name: 'Made Upson', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('a web candidate with no result naming team and position together is dropped, and the trace says so', made.found === false && made.trace.some((t) => /web candidate "Made Upson" dropped: no search result names the player, the team \(Denver Broncos\) and the position \(QB\) together/.test(t)), made.trace);
  ok('  and the message carries the trace', /No verified athlete found/.test(made.message) && /Checked: roster feeds/.test(made.message) && /web candidate "Made Upson" dropped/.test(made.message), made.message);
  const nobody = await AL.resolveAthlete(null, { name: 'Nobody Real', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('nobody anywhere: the trace says the feeds were not run and the web returned nothing', nobody.found === false && nobody.trace.some((t) => /roster feed not run/.test(t)) && nobody.trace.some((t) => /model returned 0 athlete\(s\)/.test(t)), nobody.trace);
  ok('  every trace line is logged', /for \(const line of trace\) console\.log\(`\[lookup\] \$\{level\} "\$\{name\}": \$\{line\}`\)/.test(src('server/services/athleteLookup.js')));
  ok('proWebEvidence reads positions either way: "QB" and "quarterback", "C" and "center", "SP" and "pitcher"', !!AL.proWebEvidence({ name: 'Bo Nix', team: 'Denver Broncos', position: 'QB' }, [{ title: 'Bo Nix, Broncos quarterback', url: 'u', snippet: '' }]) && !!AL.proWebEvidence({ name: 'Nikola Jokic', team: 'Denver Nuggets', position: 'C' }, [{ title: 'Jokic', url: 'u', snippet: 'Nuggets center' }]) && !!AL.proWebEvidence({ name: 'Paul Skenes', team: 'Pittsburgh Pirates', position: 'SP' }, [{ title: 'Skenes', url: 'u', snippet: 'Pirates pitcher' }]) && !AL.proWebEvidence({ name: 'Bo Nix', team: 'Denver Broncos', position: 'QB' }, [{ title: 'Bo Nix', url: 'u', snippet: 'a quarterback' }]));

  OUT.push('', '-- 5. the form, the script, the admin door --');
  const html = src('public/index.html');
  ok('the hint under the name changes for a pro: team or city, not school and sport; and the parent email is hidden', /Enter their team or city for best results/.test(html) && /show\('a_parent_wrap', !pro\)/.test(html) && /id="a_parent_wrap"/.test(html) && /id="a_lookup_hint"/.test(html));
  ok('the hit-rate script exists with ten NFL, ten NBA and ten MLB players and reports per league', (() => { const s = src('scripts/lookup-pro-hitrate.js'); return /NFL: \[/.test(s) && /NBA: \[/.test(s) && /MLB: \[/.test(s) && ['Bo Nix', 'Patrick Mahomes', 'Nikola Jokic', 'Stephen Curry', 'Aaron Judge', 'Shohei Ohtani'].every((n) => s.includes(n)) && (s.match(/\['[^\]]*'\]/g) || []).length >= 30 && /HIT RATE BY LEAGUE/.test(s) && /below the 8 of 10 bar/.test(s); })());
  const idx = src('server/index.js');
  const block = idx.slice(idx.indexOf('const ADMIN_SCRIPTS'), idx.indexOf('// GET /api/admin/verify-school-map'));
  ok('GET /api/admin/scripts/:name runs only the two named scripts, admin only, as a child process of this node', /app\.get\('\/api\/admin\/scripts\/:name', requireAuth/.test(block) && /'probe-roster-sources': \{ file: 'scripts\/probe-roster-sources\.js'/.test(block) && /'lookup-pro-hitrate': \{ file: 'scripts\/lookup-pro-hitrate\.js'/.test(block) && /user\.email !== ADMIN_EMAIL/.test(block) && /execFile\(process\.execPath/.test(block) && /No such script/.test(block));
  ok('  the query never reaches a shell: only whitelisted flags, with the value scrubbed', block.includes("['--only', String(q.only).replace(/[^a-z0-9-]/gi, '')") && block.includes("['--league', String(q.league).replace(/[^a-z]/gi, '')") && !/\bexec\(/.test(block) && !/shell: true/.test(block));
  ok('  it starts in the background and the same URL returns the output, plain with text=1', /Open this URL again in a minute or two for the output/.test(block) && /if \(q\.text\) \{ res\.type\('text\/plain'\)/.test(block) && /timeout: 15 \* 60 \* 1000/.test(block));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('prolookup: FAILED', e); process.exit(1); });
