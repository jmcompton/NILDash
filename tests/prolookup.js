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
  'Bo Nix': { citations: ['https://en.wikipedia.org/wiki/Bo_Nix', 'https://www.denverbroncos.com/team/players-roster/bo-nix/', 'https://www.instagram.com/bonix/', 'https://www.tiktok.com/@bonix10'],
    athletes: [{ name: 'Bo Nix', team: 'Denver Broncos', league: 'NFL', sport: 'football', position: 'QB', jersey: '10', highlight: '2025: 3,900 passing yards and 29 TDs through Week 17; 2024 Pro Bowl alternate and PFWA All-Rookie.', instagramHandle: 'bonix', instagram: 480000, tiktokHandle: 'bonix10', tiktok: 95000, sources: { team: 'knowledge', league: 'knowledge', sport: 'knowledge', position: 'knowledge', jersey: 'knowledge', highlight: 'https://en.wikipedia.org/wiki/Bo_Nix', instagramHandle: 'https://www.instagram.com/bonix/', instagram: 'https://www.instagram.com/bonix/', tiktokHandle: 'https://www.tiktok.com/@bonix10', tiktok: 'https://www.tiktok.com/@bonix10' }, sourceLabel: 'Wikipedia', confidence: 90 }],
    results: [{ title: 'Bo Nix - Wikipedia', url: 'https://en.wikipedia.org/wiki/Bo_Nix', snippet: 'Bo Nix is an American football quarterback for the Denver Broncos of the National Football League.' },
      { title: 'Bo Nix | Denver Broncos roster', url: 'https://www.denverbroncos.com/team/players-roster/bo-nix/', snippet: 'QB #10' }] },
  'Nikola Jokic': { citations: ['https://www.nba.com/player/203999/nikola-jokic'],
    athletes: [{ name: 'Nikola Jokić', team: 'Denver Nuggets', sport: 'basketball', position: 'C', jersey: '15', city: 'Denver, CO', highlight: '2025-26: 28.1 points, 12.9 rebounds, 10.2 assists a game; three-time MVP.', sources: { profile: 'https://www.nba.com/player/203999/nikola-jokic', team: 'knowledge', position: 'knowledge', sport: 'knowledge', city: 'knowledge' }, sourceLabel: 'NBA.com', confidence: 92 }],
    results: [{ title: 'Nikola Jokić | Denver Nuggets | NBA.com', url: 'https://www.nba.com/player/203999/nikola-jokic', snippet: 'Center, #15, Denver Nuggets.' }] },
  'Made Upson': { citations: ['https://example.com/made-upson'], athletes: [{ name: 'Made Upson', team: null, position: null, sport: 'football', highlight: 'a line about nobody', sources: { profile: 'https://example.com/made-upson' }, confidence: 80 }],
    results: [{ title: 'Made Upson', url: 'https://example.com/made-upson', snippet: 'A page that names the person and nothing about a team or a position.' }] },
  // The two the old gate dropped: the page says EDGE where the model says outside linebacker; WR where the model says wide receiver.
  'Micah Parsons': { citations: ['https://www.packers.com/team/players-roster/micah-parsons/'],
    athletes: [{ name: 'Micah Parsons', team: 'Green Bay Packers', league: 'NFL', sport: 'football', position: 'outside linebacker', jersey: '11', highlight: '2025: 11.5 sacks through Week 17; four-time Pro Bowler.', sources: { team: 'knowledge', league: 'knowledge', sport: 'knowledge', position: 'knowledge', jersey: 'knowledge', highlight: 'https://www.packers.com/team/players-roster/micah-parsons/' }, sourceLabel: 'packers.com', confidence: 88 }],
    results: [{ title: 'Micah Parsons | Green Bay Packers roster', url: 'https://www.packers.com/team/players-roster/micah-parsons/', snippet: 'EDGE #11' }] },
  "Ja'Marr Chase": { citations: ['https://www.bengals.com/team/players-roster/jamarr-chase/'],
    athletes: [{ name: "Ja'Marr Chase", team: 'Cincinnati Bengals', sport: 'football', position: 'wide receiver', jersey: '1', highlight: '2025: 1,200 receiving yards through Week 17; 2024 receiving triple crown.', sources: { team: 'knowledge', sport: 'knowledge', position: 'knowledge', jersey: 'knowledge', highlight: 'https://www.bengals.com/team/players-roster/jamarr-chase/' }, sourceLabel: 'bengals.com', confidence: 88 }],
    results: [{ title: "Ja'Marr Chase | Cincinnati Bengals", url: 'https://www.bengals.com/team/players-roster/jamarr-chase/', snippet: 'WR #1' }] },
  'Wrong Team': { citations: ['https://example.com/wrong-team'],
    athletes: [{ name: 'Wrong Team', team: 'Kansas City Chiefs', sport: 'football', sources: { team: 'knowledge', sport: 'knowledge', profile: 'https://example.com/wrong-team' }, confidence: 80 }], results: [] },
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
  ok('Bo Nix, Pro, Football, no team: team, position, jersey and sport from what the model knows, no search spent on them', nix.found === true && nix.candidates[0].team === 'Denver Broncos' && nix.candidates[0].position === 'QB' && nix.candidates[0].jersey === '10' && nix.candidates[0].sport === 'football' && nix.candidates[0].sources.team === 'knowledge' && nix.candidates[0].sources.position === 'knowledge', nix.candidates[0]);
  ok('  the same fields a college lookup fills: the highlight is the stats line, the handles and counts are cited, approximate, dated', nix.candidates[0].highlight === nix.candidates[0].stats && /3,900 passing yards/.test(nix.candidates[0].knownFor) && nix.candidates[0].instagramHandle === 'bonix' && nix.candidates[0].instagram === 480000 && nix.candidates[0].tiktokHandle === 'bonix10' && nix.candidates[0].tiktok === 95000 && nix.candidates[0].followersApprox === true && /^\d{4}-\d{2}-\d{2}$/.test(nix.candidates[0].followersAsOf || '') && /wikipedia/.test(nix.candidates[0].sources.highlight) && /instagram\.com/.test(nix.candidates[0].sources.instagram), nix.candidates[0]);
  ok('  the city comes from the team table when no page said it', nix.candidates[0].city === 'Denver, CO' && nix.candidates[0].sources.city === 'team-table');
  ok('  kept on the team the model knows; the position is a field on the card, not a test', nix.trace.some((t) => /web candidate "Bo Nix" kept: team "Denver Broncos" from model knowledge \(public figure\), position QB/.test(t)), nix.trace);
  ok('  no feed was asked, and the trace says the feeds were not run', feedCalls.length === 0 && nix.trace.some((t) => /roster feed not run/.test(t)), { calls: feedCalls, trace: nix.trace });
  ok('  the prompt: knowledge first for team, league, sport, position, city and jersey; searches only for the stats line (league page or Wikipedia), the handles and counts, and a team change', /First, from what you already know, fill the team, league, sport, position, home city and jersey number \(source "knowledge"\)/.test(loopCalls[0]) && /"Bo Nix" stats \(the official league page: nfl\.com, nba\.com, mlb\.com, nhl\.com, mlssoccer\.com, wnba\.com, or Wikipedia/.test(loopCalls[0]) && /current season line and career highlights as "highlight"/.test(loopCalls[0]) && /"Bo Nix" instagram; "Bo Nix" tiktok/.test(loopCalls[0]) && /If a result shows a newer team than you knew, use it and cite the page/.test(loopCalls[0]) && /Use your searches ONLY for what changes/.test(loopCalls[0]) && !/Never guess, never fill from memory/.test(loopCalls[0]), loopCalls[0]);
  ok('  the college rules are untouched: every field from a page, never from memory', /Never guess, never fill from memory/.test(AL.RULES) && /Never guess, never fill from memory/.test(AL.promptFor('college', { name: 'x', school: 'Auburn' })) && !/knowledge/.test(AL.promptFor('college', { name: 'x', school: 'Auburn' })));
  ok('  and the sanitiser takes knowledge only for a pro, only for those six fields', AL.KNOWN_OK.size === 6 && (() => { const c = AL.sanitizeWeb({ name: 'X Y', school: 'Auburn', position: 'QB', highlight: 'h', sources: { school: 'knowledge', position: 'knowledge', highlight: 'knowledge' } }, [], 'college'); return c === null; })() && (() => { const c = AL.sanitizeWeb({ name: 'X Y', team: 'T', position: 'QB', highlight: 'h', sources: { team: 'knowledge', position: 'knowledge', highlight: 'knowledge' } }, [], 'pro'); return c && c.team === 'T' && c.position === 'QB' && c.highlight === undefined; })());
  const jok = await AL.resolveAthlete(null, { name: 'Nikola Jokic', sport: 'basketball', athleteType: 'pro', team: 'Denver Nuggets' }, { force: true });
  ok('NBA: Nikola Jokić, Denver Nuggets, C, #15, the city the model knew, the stats line from NBA.com', jok.found && jok.candidates[0].team === 'Denver Nuggets' && jok.candidates[0].position === 'C' && jok.candidates[0].jersey === '15' && jok.candidates[0].city === 'Denver, CO' && jok.candidates[0].sources.city === 'knowledge' && /three-time MVP/.test(jok.candidates[0].highlight), jok.candidates[0]);
  ok('  with the team in the query', /"Nikola Jokic" Denver Nuggets stats/.test(loopCalls[loopCalls.length - 1]));

  OUT.push('', '-- 4. no team, no candidate; nothing, the trace --');
  const made = await AL.resolveAthlete(null, { name: 'Made Upson', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('a web candidate with no team is dropped (the team is a pro\'s anchor, as the school is a college athlete\'s), and the trace says so', made.found === false && made.trace.some((t) => /web candidate "Made Upson" dropped: no team$/.test(t)), made.trace);
  ok('  and the message carries the trace', /No verified athlete found/.test(made.message) && /Checked: roster feeds/.test(made.message) && /web candidate "Made Upson" dropped/.test(made.message), made.message);
  const nobody = await AL.resolveAthlete(null, { name: 'Nobody Real', sport: 'football', athleteType: 'pro' }, { force: true });
  ok('nobody anywhere: the trace says the feeds were not run and the web returned nothing', nobody.found === false && nobody.trace.some((t) => /roster feed not run/.test(t)) && nobody.trace.some((t) => /model returned 0 athlete\(s\)/.test(t)), nobody.trace);
  ok('  every trace line is logged', /for \(const line of trace\) console\.log\(`\[lookup\] \$\{level\} "\$\{name\}": \$\{line\}`\)/.test(src('server/services/athleteLookup.js')));
  OUT.push('', '-- 4b. no second gate for a pro: the same rule as college, a different anchor --');
  const parsons = await AL.resolveAthlete(null, { name: 'Micah Parsons', sport: 'football', athleteType: 'pro', team: 'Green Bay Packers' }, { force: true });
  ok('Micah Parsons is accepted although the roster page says EDGE and the model says outside linebacker', parsons.found === true && parsons.candidates[0].team === 'Green Bay Packers' && parsons.candidates[0].position === 'outside linebacker', parsons.trace);
  const chase = await AL.resolveAthlete(null, { name: "Ja'Marr Chase", sport: 'football', athleteType: 'pro', team: 'Bengals' }, { force: true });
  ok("Ja'Marr Chase is accepted although the page says WR and the model says wide receiver", chase.found === true && chase.candidates[0].team === 'Cincinnati Bengals' && chase.candidates[0].position === 'wide receiver', chase.trace);
  ok('  a pro with a team and a source but NO position is still accepted: the position is a field to fill in', (() => { const w = { name: 'Wrong Team', team: 'Kansas City Chiefs', sources: { team: 'knowledge' } }; return AL.webCandidateProblem('pro', { name: 'Wrong Team', team: '' }, w) === null; })());
  const wrong = await AL.resolveAthlete(null, { name: 'Wrong Team', sport: 'football', athleteType: 'pro', team: 'Denver Broncos' }, { force: true });
  ok('  but a candidate on a different team from the one the agent named is dropped, and the trace says which', wrong.found === false && wrong.trace.some((t) => /web candidate "Wrong Team" dropped: team "Kansas City Chiefs" is not "Denver Broncos"/.test(t)), wrong.trace);
  ok('  the team check reads nicknames and cities the way the school check reads aliases', AL.anchorsAgree('pro', 'Cincinnati Bengals', 'Bengals') && AL.anchorsAgree('pro', 'Green Bay Packers', 'Packers') && !AL.anchorsAgree('pro', 'Denver Broncos', 'Denver Nuggets'));
  ok('ONE RULE FOR EVERY LEVEL: the anchor is the school for college and high school, the team for a pro', JSON.stringify(AL.ANCHOR) === '{"college":"school","high_school":"school","pro":"team"}');
  ok('  college: a candidate at a different school from the one asked is dropped by the same function', /school "Alabama" is not "Auburn University"/.test(AL.webCandidateProblem('college', { name: 'Sam Jones', school: 'Auburn University' }, { name: 'Sam Jones', school: 'Alabama' }) || '') && AL.webCandidateProblem('college', { name: 'Sam Jones', school: 'Auburn University' }, { name: 'Sam Jones', school: 'Auburn' }) === null);
  ok('  and a wrong name is dropped at every level', /name "Someone Else" is not "Sam Jones"/.test(AL.webCandidateProblem('pro', { name: 'Sam Jones', team: '' }, { name: 'Someone Else', team: 'Denver Broncos' }) || ''));
  ok('  the old evidence gate is gone from the code', !/proWebEvidence|corroborated by|no search result corroborated/.test(src('server/services/athleteLookup.js')));
  ok('  and the college branch and the pro branch go through webCandidateProblem, once', (src('server/services/athleteLookup.js').match(/webCandidateProblem\(level, anchorQ, w\)/g) || []).length === 1);

  OUT.push('', '-- 5. the form, the script, the admin door --');
  const html = src('public/index.html');
  ok('the hint under the name changes for a pro: team or city, not school and sport; and the parent email is hidden', /Enter their team or city for best results/.test(html) && /show\('a_parent_wrap', !pro\)/.test(html) && /id="a_parent_wrap"/.test(html) && /id="a_lookup_hint"/.test(html));
  ok('the hit-rate script exists with ten NFL, ten NBA and ten MLB players and reports the athlete, stats, Instagram handle and follower count rates per league', (() => { const s = src('scripts/lookup-pro-hitrate.js'); return /NFL: \[/.test(s) && /NBA: \[/.test(s) && /MLB: \[/.test(s) && ['Bo Nix', 'Patrick Mahomes', 'Nikola Jokic', 'Stephen Curry', 'Aaron Judge', 'Shohei Ohtani'].every((n) => s.includes(n)) && (s.match(/\['[^\]]*'\]/g) || []).length >= 30 && /const FRESH = flag\('fresh'\) \|\| flag\('force'\)/.test(s) && /force: FRESH/.test(s) && /HIT RATE BY LEAGUE \(athlete found \/ stats filled \/ Instagram handle \/ follower count\)/.test(s) && /stats \$\{t\.stats\} of/.test(s) && /instagram handle \$\{t\.handle\} of/.test(s); })());
  const idx = src('server/index.js');
  const block = idx.slice(idx.indexOf('const ADMIN_SCRIPTS'), idx.indexOf('// GET /api/admin/verify-school-map'));
  ok('GET /api/admin/scripts/:name runs only the two named scripts, admin only, as a child process of this node', /app\.get\('\/api\/admin\/scripts\/:name', requireAuth/.test(block) && /'probe-roster-sources': \{ file: 'scripts\/probe-roster-sources\.js'/.test(block) && /'lookup-pro-hitrate': \{ file: 'scripts\/lookup-pro-hitrate\.js'/.test(block) && /user\.email !== ADMIN_EMAIL/.test(block) && /execFile\(process\.execPath/.test(block) && /No such script/.test(block) && /\(q\.fresh \|\| q\.force\) \? \['--fresh'\]/.test(block));
  ok('  the query never reaches a shell: only whitelisted flags, with the value scrubbed', block.includes("['--only', String(q.only).replace(/[^a-z0-9-]/gi, '')") && block.includes("['--league', String(q.league).replace(/[^a-z]/gi, '')") && !/\bexec\(/.test(block) && !/shell: true/.test(block));
  ok('  it starts in the background and the same URL returns the output, plain with text=1', /Open this URL again in a minute or two for the output/.test(block) && /if \(q\.text\) \{ res\.type\('text\/plain'\)/.test(block) && /timeout: 15 \* 60 \* 1000/.test(block));

  OUT.push(''); OUT.push('failures: ' + F);
  console.log(OUT.join('\n'));
  process.exit(F ? 1 : 0);
})().catch((e) => { console.error('prolookup: FAILED', e); process.exit(1); });
