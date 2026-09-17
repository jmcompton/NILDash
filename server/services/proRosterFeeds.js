'use strict';
// ── PRO AND MINOR LEAGUE ROSTER FEEDS ────────────────────────────────────────
//
// The feeds scripts/probe-roster-sources.js tests, read by the athlete
// lookup before it spends a web search. A feed answers with a structured
// roster, so a player found here comes with a position, a jersey number, a
// height and weight and a hometown that were READ OFF THE FEED, and every
// one of those fields carries the feed URL as its source.
//
//   ESPN site API     NFL, CFL, UFL, NBA, WNBA, NHL, MLB, MLS, NWSL, USL
//                     Championship, USL League One. Teams, then one roster.
//   MLB StatsAPI      MLB and every affiliated minor league level (AAA..A),
//                     by name search. No key.
//   NHL API           the league's own player search.
//   HockeyTech        AHL and ECHL, behind public client keys copied from the
//                     league sites. FRAGILE: a rotated key answers with no
//                     teams, and the lookup falls through to web search.
//   G League          NBA's stats host with the G League id. FRAGILE: refuses
//                     most server clients. Name and team only when it answers.
//
// Every feed is one or two GETs with a short timeout, every failure is a
// note rather than an error, and the caller falls back to cited web search
// for anything the feeds did not settle. Nothing here reads a birth date:
// the feeds carry one for most players and it is never copied.
//
// _setFetchForTests replaces the GET so the suite runs on fixtures.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const TIMEOUT_MS = parseInt(process.env.ROSTER_FEED_TIMEOUT_MS, 10) || 8000;

let _fetchJson = null;
async function getJson(url, headers) {
  if (_fetchJson) return _fetchJson(url, headers);
  const ac = new AbortController();
  const killer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ac.signal, headers: Object.assign({ 'User-Agent': UA, Accept: 'application/json' }, headers || {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return JSON.parse(text);
  } finally { clearTimeout(killer); }
}
function _setFetchForTests(fn) { _fetchJson = fn || null; _rosterCache.clear(); }

// ── ONE HOUR OF ROSTERS, PER PROCESS ─────────────────────────────────────
// Searching a league by name means reading every roster (32 requests for the
// NFL). Read once and kept an hour, so the second pro lookup of the night is
// free and the hit-rate script does not hammer ESPN.
const ROSTER_CACHE_MS = 60 * 60 * 1000;
const _rosterCache = new Map();
async function cachedJson(url) {
  const hit = _rosterCache.get(url);
  if (hit && Date.now() - hit.at < ROSTER_CACHE_MS) return hit.json;
  const json = await getJson(url);
  _rosterCache.set(url, { at: Date.now(), json });
  return json;
}
// How many rosters a league-wide read may cost. Every major league fits.
const LEAGUE_READ_MAX_TEAMS = 40;

// ── WHICH FEEDS FOR WHICH SPORT ──────────────────────────────────────────────
// ESPN paths are the league's slug on the site API. A bare sport names every
// league of that sport; the roster page says which one the player is on.
const ESPN_LEAGUES = {
  NFL: { path: 'football/nfl', sport: 'football' },
  CFL: { path: 'football/cfl', sport: 'football' },
  UFL: { path: 'football/ufl', sport: 'football' },
  NBA: { path: 'basketball/nba', sport: 'basketball' },
  WNBA: { path: 'basketball/wnba', sport: 'basketball' },
  NHL: { path: 'hockey/nhl', sport: 'hockey' },
  MLB: { path: 'baseball/mlb', sport: 'baseball' },
  MLS: { path: 'soccer/usa.1', sport: 'soccer' },
  NWSL: { path: 'soccer/usa.nwsl', sport: 'soccer' },
  'USL Championship': { path: 'soccer/usa.usl.1', sport: 'soccer' },
  'USL League One': { path: 'soccer/usa.usl.l1', sport: 'soccer' },
};

function leaguesForSport(sport) {
  const s = String(sport || '').toLowerCase();
  const out = [];
  if (!s) return out;
  if (/football/.test(s)) out.push('NFL', 'UFL', 'CFL');
  if (/basketball/.test(s)) {
    if (/women|wnba/.test(s)) out.push('WNBA');
    else if (/men|nba/.test(s)) out.push('NBA', 'G League');
    else out.push('NBA', 'WNBA', 'G League');
  }
  if (/baseball/.test(s)) out.push('MLB');   // StatsAPI covers MLB and the minors in one search
  if (/hockey/.test(s)) out.push('NHL', 'AHL', 'ECHL');
  if (/soccer/.test(s)) {
    if (/women|nwsl/.test(s)) out.push('NWSL');
    else if (/men|mls/.test(s)) out.push('MLS', 'USL Championship', 'USL League One');
    else out.push('MLS', 'NWSL', 'USL Championship', 'USL League One');
  }
  return out;
}

// ── NAME AND TEAM MATCHING ───────────────────────────────────────────────────
function nameScore(q, c) { return require('./athleteLookup').nameMatchScore(q, c); }
const fold = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function teamMatches(want, team) {
  if (!want) return true;
  const w = fold(want), t = fold(team);
  if (!w || !t) return false;
  if (t === w || t.includes(w) || w.includes(t)) return true;
  // "Broncos" against "Denver Broncos", "NYCFC" against "New York City FC"
  const ww = w.split(' ').filter((x) => x.length > 2);
  return ww.length > 0 && ww.every((x) => t.includes(x));
}

// A candidate in the lookup's shape: flat fields plus `sources`, the same
// URL on every field the feed supplied.
function candidate(fields, league, url, label, confidence) {
  const sources = {};
  for (const [k, v] of Object.entries(fields)) if (v !== null && v !== undefined && v !== '' && k !== 'sport' && k[0] !== '_') sources[k] = url;
  return Object.assign({ athleteType: 'pro', league, sourceUrl: url, source: 'roster-feed', sourceLabel: label, confidence, sources }, fields);
}

// ── ESPN: teams, then the team's roster ──────────────────────────────────────
function espnTeamScore(want, team) {
  const w = fold(want);
  const disp = fold(team.displayName), loc = fold(team.location), nick = fold(team.name), abbr = fold(team.abbreviation);
  if (!w) return 0;
  if (disp === w) return 100;
  if (abbr && abbr === w) return 95;
  if (loc === w || nick === w) return 90;
  if (disp.includes(w) || w.includes(disp)) return 80;
  if (nick && w.includes(nick)) return 70;
  if (loc && w.includes(loc)) return 65;
  return 0;
}
async function espnLeague(league, q, notes) {
  const def = ESPN_LEAGUES[league];
  if (!def) return [];
  const teamsUrl = `${ESPN}/${def.path}/teams?limit=100`;
  let teams;
  try {
    const j = await cachedJson(teamsUrl);
    teams = ((((j.sports || [])[0] || {}).leagues || [])[0] || {}).teams || [];
  } catch (e) { notes.push(`${league}: teams feed did not answer (${e.message})`); return []; }
  if (!teams.length) { notes.push(`${league}: teams feed answered with no teams`); return []; }
  // WITH A TEAM, ONE ROSTER. The team may be a nickname ("Broncos") or a
  // full name; services/proTeams settles it to the club before the feed's
  // own matcher runs. WITHOUT A TEAM, EVERY ROSTER IN THE LEAGUE: this used
  // to give up here ("no team given, so the roster feed was not read"), which
  // is why "Bo Nix", Pro, Football, no team, found nobody. Rosters are read
  // in parallel and cached an hour.
  let wanted = q.team ? String(q.team).trim() : '';
  if (wanted) { try { const t = require('./proTeams').findTeam(wanted); if (t && t.league === league) wanted = t.name; } catch (_) { /* the feed's matcher still runs */ } }
  let rosterTeams = [];
  if (wanted) {
    let best = null, bestScore = 0;
    for (const { team } of teams) { const s = espnTeamScore(wanted, team || {}); if (s > bestScore) { bestScore = s; best = team; } }
    if (!best || bestScore < 65) { notes.push(`${league}: no team matches "${q.team}"`); return []; }
    rosterTeams = [best];
  } else {
    rosterTeams = teams.map((x) => x.team).filter(Boolean).slice(0, LEAGUE_READ_MAX_TEAMS);
  }
  const rosters = await Promise.all(rosterTeams.map(async (t) => {
    const rosterUrl = `${ESPN}/${def.path}/teams/${t.id}/roster`;
    try { return { team: t, url: rosterUrl, json: await cachedJson(rosterUrl) }; }
    catch (e) { return { team: t, url: rosterUrl, error: e.message }; }
  }));
  const failed = rosters.filter((r) => r.error);
  if (failed.length) notes.push(`${league}: ${failed.length} of ${rosters.length} roster feed(s) did not answer (${failed[0].team.displayName}: ${failed[0].error})`);
  const out = [];
  let playersRead = 0;
  for (const r of rosters) {
    if (r.error) continue;
    const best = r.team, rosterUrl = r.url, j = r.json;
  const groups = Array.isArray(j.athletes) ? j.athletes : [];
  const players = groups.flatMap((g) => (g && Array.isArray(g.items)) ? g.items : (g && g.fullName ? [g] : []));
  playersRead += players.length;
  for (const p of players) {
    const name = p.fullName || [p.firstName, p.lastName].filter(Boolean).join(' ');
    const ns = nameScore(q.name, name);
    if (ns < 25) continue;
    const bp = p.birthPlace || {};
    const hometown = [bp.city, bp.state || bp.country].filter(Boolean).join(', ') || null;
    const page = (Array.isArray(p.links) && p.links.find((l) => /playercard|player/i.test(String(l.rel || l.text || '')) && l.href)) || null;
    out.push(candidate({
      name, team: best.displayName, city: best.location || null, sport: def.sport,
      position: (p.position && (p.position.abbreviation || p.position.name)) || null,
      jersey: p.jersey || null, height: p.displayHeight || null, weight: p.displayWeight || (p.weight ? `${Math.round(p.weight)} lbs` : null),
      hometown, hometownState: bp.state || null, college: (p.college && p.college.name) || null,
      _ns: ns,
    }, league, (page && page.href) || rosterUrl, `ESPN ${league} roster`, Math.min(96, 60 + ns)));
  }
  }
  const where = wanted ? `${rosterTeams[0].displayName} roster` : `${rosters.length - failed.length} rosters, ${playersRead} players`;
  if (!out.length) notes.push(`${league}: ${where} read, nobody named like "${q.name}"`);
  else notes.push(`${league}: ${where} read, ${out.length} match(es) for "${q.name}"`);
  return out;
}

// ── MLB StatsAPI: MLB and the affiliated minors, by name ─────────────────────
const MLB_SPORT_IDS = { 1: 'MLB', 11: 'Triple-A', 12: 'Double-A', 13: 'High-A', 14: 'Single-A' };
async function mlbStatsApi(q, notes) {
  const url = `https://statsapi.mlb.com/api/v1/people/search?names=${encodeURIComponent(q.name)}&sportIds=1,11,12,13,14&hydrate=currentTeam`;
  let j;
  try { j = await getJson(url); } catch (e) { notes.push(`MLB StatsAPI: did not answer (${e.message})`); return []; }
  const people = Array.isArray(j.people) ? j.people : [];
  const out = [];
  for (const p of people) {
    const ns = nameScore(q.name, p.fullName);
    if (ns < 25) continue;
    const team = p.currentTeam || {};
    const teamName = team.name || null;
    if (q.team && teamName && !teamMatches(q.team, teamName)) continue;
    const level = MLB_SPORT_IDS[(team.sport && team.sport.id) || (p.currentTeam && p.currentTeam.sportId)] || (p.active === false ? 'MLB (inactive)' : 'MLB or minors');
    const hometown = [p.birthCity, p.birthStateProvince || p.birthCountry].filter(Boolean).join(', ') || null;
    const page = p.id ? `https://www.mlb.com/player/${p.id}` : url;
    out.push(candidate({
      name: p.fullName, team: teamName, city: (team.locationName) || null, sport: 'baseball',
      position: (p.primaryPosition && (p.primaryPosition.abbreviation || p.primaryPosition.name)) || null,
      jersey: p.primaryNumber || null, height: p.height || null, weight: p.weight ? `${p.weight} lbs` : null,
      hometown, hometownState: p.birthStateProvince || null, _ns: ns,
    }, level, page, `MLB StatsAPI (${level})`, Math.min(96, 60 + ns)));
  }
  if (!out.length) notes.push(`MLB StatsAPI: nobody named like "${q.name}"${q.team ? ' on ' + q.team : ''}`);
  return out;
}

// ── NHL: the league's player search ──────────────────────────────────────────
async function nhlSearch(q, notes) {
  const url = `https://search.d3.nhle.com/api/v1/search/player?culture=en-us&limit=20&q=${encodeURIComponent(q.name)}`;
  let j;
  try { j = await getJson(url); } catch (e) { notes.push(`NHL API: did not answer (${e.message})`); return []; }
  const list = Array.isArray(j) ? j : (Array.isArray(j.results) ? j.results : []);
  const out = [];
  for (const p of list) {
    const name = p.name || [p.firstName, p.lastName].filter(Boolean).join(' ');
    const ns = nameScore(q.name, name);
    if (ns < 25) continue;
    const team = p.teamAbbrev || p.teamName || null;
    if (q.team && team && !teamMatches(q.team, p.teamName || team) && fold(q.team) !== fold(team)) continue;
    const h = p.heightInInches ? `${Math.floor(p.heightInInches / 12)}-${p.heightInInches % 12}` : null;
    const page = p.playerId ? `https://www.nhl.com/player/${p.playerId}` : url;
    out.push(candidate({
      name, team: p.teamName || team, city: null, sport: 'hockey', position: p.positionCode || null,
      jersey: p.sweaterNumber != null ? String(p.sweaterNumber) : null, height: h, weight: p.weightInPounds ? `${p.weightInPounds} lbs` : null,
      hometown: [p.birthCity, p.birthStateProvince || p.birthCountry].filter(Boolean).join(', ') || null,
      hometownState: p.birthStateProvince || null, _ns: ns,
    }, 'NHL', page, 'NHL player search', Math.min(96, 60 + ns)));
  }
  if (!out.length) notes.push(`NHL API: nobody named like "${q.name}"`);
  return out;
}

// ── HockeyTech: AHL and ECHL ─────────────────────────────────────────────────
const HOCKEYTECH = {
  AHL: { client: 'ahl', key: process.env.HOCKEYTECH_AHL_KEY || 'ccb91f29d6744675', site: 'https://theahl.com' },
  ECHL: { client: 'echl', key: process.env.HOCKEYTECH_ECHL_KEY || '2c680dd4a6dc3d7d', site: 'https://echl.com' },
};
async function hockeyTech(league, q, notes) {
  const def = HOCKEYTECH[league];
  if (!def) return [];
  const base = `https://lscluster.hockeytech.com/feed/?feed=modulekit&key=${def.key}&client=${def.client}&fmt=json`;
  let teams, seasonId;
  try {
    const j = await getJson(`${base}&view=teamsbyseason`);
    teams = ((j.SiteKit || {}).Teamsbyseason) || [];
    seasonId = teams.length && (teams[0].season_id || null);
  } catch (e) { notes.push(`${league}: HockeyTech did not answer (${e.message})`); return []; }
  if (!teams.length) { notes.push(`${league}: HockeyTech answered with no teams (the public key may have rotated)`); return []; }
  if (!q.team) { notes.push(`${league}: no team given, so the roster feed was not read`); return []; }
  const team = teams.find((t) => teamMatches(q.team, t.name)) || teams.find((t) => teamMatches(q.team, t.nickname || t.code));
  if (!team) { notes.push(`${league}: no team matches "${q.team}"`); return []; }
  let roster;
  try {
    const j = await getJson(`${base}&view=roster&team_id=${team.id}${seasonId ? '&season_id=' + seasonId : ''}`);
    roster = ((j.SiteKit || {}).Roster) || [];
  } catch (e) { notes.push(`${league}: roster for ${team.name} did not answer (${e.message})`); return []; }
  const out = [];
  for (const p of roster) {
    const name = p.name || [p.first_name, p.last_name].filter(Boolean).join(' ');
    const ns = nameScore(q.name, name);
    if (ns < 25) continue;
    out.push(candidate({
      name, team: team.name, city: team.city || null, sport: 'hockey', position: p.position || null,
      jersey: p.tp_jersey_number || p.jersey_number || null, height: p.height || null, weight: p.weight ? `${p.weight} lbs` : null,
      hometown: p.birthtown ? [p.birthtown, p.birthprov].filter(Boolean).join(', ') : null, hometownState: p.birthprov || null, _ns: ns,
    }, league, `${def.site}/stats/player/${p.player_id || ''}`, `${league} (HockeyTech feed)`, Math.min(94, 58 + ns)));
  }
  if (!out.length) notes.push(`${league}: ${team.name} roster has nobody named like "${q.name}"`);
  return out;
}

// ── G League: NBA's stats host ───────────────────────────────────────────────
async function gLeague(q, notes) {
  const y = new Date().getUTCFullYear();
  const url = `https://stats.nba.com/stats/commonallplayers?LeagueID=20&Season=${y - 1}-${String(y).slice(2)}&IsOnlyCurrentSeason=1`;
  let j;
  try { j = await getJson(url, { Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com' }); }
  catch (e) { notes.push(`G League: stats host refused or did not answer (${e.message})`); return []; }
  const rs = (j.resultSets || [])[0];
  if (!rs || !Array.isArray(rs.rowSet)) { notes.push('G League: no resultSets in the body'); return []; }
  const cols = rs.headers || [];
  const ix = (k) => cols.indexOf(k);
  const out = [];
  for (const row of rs.rowSet) {
    const name = row[ix('DISPLAY_FIRST_LAST')] || '';
    const ns = nameScore(q.name, name);
    if (ns < 25) continue;
    const team = [row[ix('TEAM_CITY')], row[ix('TEAM_NAME')]].filter(Boolean).join(' ') || null;
    if (q.team && team && !teamMatches(q.team, team)) continue;
    out.push(candidate({ name, team, city: row[ix('TEAM_CITY')] || null, sport: 'basketball', _ns: ns },
      'G League', url, 'G League (NBA stats feed)', Math.min(90, 55 + ns)));
  }
  if (!out.length) notes.push(`G League: nobody named like "${q.name}"`);
  return out;
}

// ── THE ENTRY POINT ──────────────────────────────────────────────────────────
// searchFeeds({ name, sport, team }) -> { candidates, notes, feedsTried }
// Every feed for the sport runs at once; the answer is the union, best name
// match first. A feed that fails is a note.
async function searchFeeds(q) {
  const notes = [];
  const leagues = leaguesForSport(q.sport);
  if (!q.name) return { candidates: [], notes: ['no name'], feedsTried: [] };
  if (!leagues.length) { notes.push(`no roster feed for sport "${q.sport || 'unknown'}"; web search only`); return { candidates: [], notes, feedsTried: [] }; }
  const jobs = leagues.map((lg) => {
    if (lg === 'MLB') return mlbStatsApi(q, notes);
    if (lg === 'NHL') return Promise.all([nhlSearch(q, notes), espnLeague('NHL', q, notes)]).then((a) => a.flat());
    if (lg === 'AHL' || lg === 'ECHL') return hockeyTech(lg, q, notes);
    if (lg === 'G League') return gLeague(q, notes);
    return espnLeague(lg, q, notes);
  });
  const settled = await Promise.allSettled(jobs);
  const candidates = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') candidates.push(...s.value);
    else notes.push(`${leagues[i]}: ${s.reason && s.reason.message}`);
  });
  // The same player from two feeds (NHL search and ESPN NHL) is one candidate:
  // keep the richer one.
  const byKey = new Map();
  for (const c of candidates) {
    const k = fold(c.name) + '|' + fold(c.team);
    const prev = byKey.get(k);
    const richness = (x) => Object.keys(x.sources || {}).length;
    if (!prev || richness(c) > richness(prev)) byKey.set(k, c);
  }
  const out = [...byKey.values()].sort((a, b) => (b._ns || 0) - (a._ns || 0) || (b.confidence || 0) - (a.confidence || 0));
  return { candidates: out, notes, feedsTried: leagues };
}

module.exports = { searchFeeds, leaguesForSport, teamMatches, ESPN_LEAGUES, _setFetchForTests };
