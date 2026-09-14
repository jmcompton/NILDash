#!/usr/bin/env node
'use strict';
// ── WHICH PRO AND MINOR LEAGUE ROSTER FEEDS ANSWER FROM HERE ─────────────────
//
//   node scripts/probe-roster-sources.js            every source
//   node scripts/probe-roster-sources.js --only mlb  one league (substring of the label)
//
// Report only. Makes one GET per source, no database, no key. Run it FROM
// RAILWAY: the pro lookup will run there, and whether a feed answers depends
// on where the request comes from (NBA's stats host refuses most servers, and
// the development sandbox this was written in reaches none of them).
//
// Each line says: label, HTTP status, bytes, and what the body contained --
// a team count, a roster count, a player name -- so "200" cannot be mistaken
// for "usable". A source that returns 200 with an HTML login page prints
// "not JSON". The last block says which tier each league lands in:
//
//   FEED      a structured roster feed answers; the lookup can read it directly
//   FRAGILE   answers, but through a key or a header copied from a public site
//   SEARCH    no feed; the lookup stays on cited web search for this league

const https = require('https');
const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? String(process.argv[i + 1] || '').toLowerCase() : null; })();
process.exitCode = 1;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const YEAR = new Date().getUTCFullYear();
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const ESPN_HDR = { 'User-Agent': UA, Accept: 'application/json' };

// Every source, what league it stands for, and how to tell a usable body from
// a 200 that says nothing. `tier` is the claim being tested.
const SOURCES = [
  // ── ESPN site API: the majors, plus CFL and UFL. Same host the college lookup uses.
  { label: 'NFL   ESPN teams',   league: 'NFL', tier: 'FEED', url: `${ESPN}/football/nfl/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'NFL   ESPN roster',  league: 'NFL', tier: 'FEED', url: `${ESPN}/football/nfl/teams/7/roster`, headers: ESPN_HDR, check: espnRoster },   // 7 = Denver
  { label: 'CFL   ESPN teams',   league: 'CFL', tier: 'FEED', url: `${ESPN}/football/cfl/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'UFL   ESPN teams',   league: 'UFL', tier: 'FEED', url: `${ESPN}/football/ufl/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'NBA   ESPN teams',   league: 'NBA', tier: 'FEED', url: `${ESPN}/basketball/nba/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'WNBA  ESPN teams',   league: 'WNBA', tier: 'FEED', url: `${ESPN}/basketball/wnba/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'NHL   ESPN teams',   league: 'NHL', tier: 'FEED', url: `${ESPN}/hockey/nhl/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'MLB   ESPN teams',   league: 'MLB', tier: 'FEED', url: `${ESPN}/baseball/mlb/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'MLS   ESPN teams',   league: 'MLS', tier: 'FEED', url: `${ESPN}/soccer/usa.1/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'USL-C ESPN teams',   league: 'USL Championship', tier: 'FEED', url: `${ESPN}/soccer/usa.usl.1/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },
  { label: 'USL-1 ESPN teams',   league: 'USL League One', tier: 'FEED', url: `${ESPN}/soccer/usa.usl.l1/teams?limit=100`, headers: ESPN_HDR, check: espnTeams },

  // ── MLB StatsAPI: MLB and every affiliated minor league level, with stats. No key.
  { label: 'MLB   StatsAPI sports', league: 'MLB', tier: 'FEED', url: 'https://statsapi.mlb.com/api/v1/sports', check: (j) => `${(j.sports || []).length} sports: ${(j.sports || []).map((s) => s.id + '=' + s.abbreviation).join(' ')}` },
  { label: 'AAA   StatsAPI teams',  league: 'Triple-A', tier: 'FEED', url: `https://statsapi.mlb.com/api/v1/teams?sportId=11&season=${YEAR}`, check: statsTeams },
  { label: 'AA    StatsAPI teams',  league: 'Double-A', tier: 'FEED', url: `https://statsapi.mlb.com/api/v1/teams?sportId=12&season=${YEAR}`, check: statsTeams },
  { label: 'A+    StatsAPI teams',  league: 'High-A', tier: 'FEED', url: `https://statsapi.mlb.com/api/v1/teams?sportId=13&season=${YEAR}`, check: statsTeams },
  { label: 'A     StatsAPI teams',  league: 'Single-A', tier: 'FEED', url: `https://statsapi.mlb.com/api/v1/teams?sportId=14&season=${YEAR}`, check: statsTeams },
  { label: 'AAA   StatsAPI roster', league: 'Triple-A', tier: 'FEED', url: `https://statsapi.mlb.com/api/v1/teams/512/roster?season=${YEAR}`, check: (j) => rosterCount(j.roster, (p) => p.person && p.person.fullName) },   // 512 = Toledo Mud Hens
  { label: 'MiLB  StatsAPI search', league: 'Minor leagues', tier: 'FEED', url: 'https://statsapi.mlb.com/api/v1/people/search?names=Smith&sportIds=11,12,13,14', check: (j) => `${(j.people || []).length} people named Smith across AAA..A` },
  { label: 'MiLB  StatsAPI stats',  league: 'Minor leagues', tier: 'FEED', url: `https://statsapi.mlb.com/api/v1/people/search?names=Smith&sportIds=11&hydrate=stats(group=[hitting],type=[season],season=${YEAR})`, check: (j) => { const p = (j.people || []).find((x) => x.stats && x.stats.length); return p ? `season hitting line present for ${p.fullName}` : 'no stats block on any hit (check season / hydrate)'; } },

  // ── NHL: the league's own API. AHL and ECHL: HockeyTech feeds behind the league sites (public client keys, may rotate).
  { label: 'NHL   NHL API roster', league: 'NHL', tier: 'FEED', url: 'https://api-web.nhle.com/v1/roster/COL/current', check: (j) => rosterCount([].concat(j.forwards || [], j.defensemen || [], j.goalies || []), (p) => p.firstName && p.firstName.default) },
  { label: 'AHL   HockeyTech teams', league: 'AHL', tier: 'FRAGILE', url: 'https://lscluster.hockeytech.com/feed/?feed=modulekit&view=teamsbyseason&key=ccb91f29d6744675&client=ahl&fmt=json', check: (j) => `${((j.SiteKit || {}).Teamsbyseason || []).length} teams (key copied from theahl.com; a 0 here means the key rotated)` },
  { label: 'ECHL  HockeyTech teams', league: 'ECHL', tier: 'FRAGILE', url: 'https://lscluster.hockeytech.com/feed/?feed=modulekit&view=teamsbyseason&key=2c680dd4a6dc3d7d&client=echl&fmt=json', check: (j) => `${((j.SiteKit || {}).Teamsbyseason || []).length} teams (key copied from echl.com; a 0 here means the key rotated)` },

  // ── G League: NBA's stats host with the G League id. Refuses most server clients even with browser headers.
  { label: 'GLG   NBA stats players', league: 'G League', tier: 'FRAGILE', url: `https://stats.nba.com/stats/commonallplayers?LeagueID=20&Season=${YEAR - 1}-${String(YEAR).slice(2)}&IsOnlyCurrentSeason=1`,
    headers: { 'User-Agent': UA, Referer: 'https://www.nba.com/', Origin: 'https://www.nba.com', Accept: 'application/json' },
    check: (j) => { const rs = (j.resultSets || [])[0]; return rs ? `${(rs.rowSet || []).length} players` : 'no resultSets'; } },

  // ── USL: no feed. This is only "does the league site answer", the tier is SEARCH regardless.
  { label: 'USL-C site',          league: 'USL Championship', tier: 'SEARCH', url: 'https://www.uslchampionship.com/', check: () => 'html page (no feed; the lookup web-searches team roster pages)', html: true },
];

function espnTeams(j) {
  const teams = (((j.sports || [])[0] || {}).leagues || [])[0];
  const n = teams && teams.teams ? teams.teams.length : 0;
  return n ? `${n} teams, e.g. ${teams.teams.slice(0, 2).map((t) => t.team.displayName).join(', ')}` : 'no teams in body';
}
function espnRoster(j) {
  const groups = j.athletes || [];
  const flat = groups.flatMap((g) => g.items || []);
  return rosterCount(flat, (p) => p.fullName);
}
function statsTeams(j) {
  const t = j.teams || [];
  return t.length ? `${t.length} teams, e.g. ${t.slice(0, 2).map((x) => x.name).join(', ')}` : 'no teams in body';
}
function rosterCount(list, nameOf) {
  const l = list || [];
  const names = l.map(nameOf).filter(Boolean);
  return names.length ? `${names.length} on roster, e.g. ${names.slice(0, 2).join(', ')}` : 'no players in body';
}

function get(url, headers) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.get(url, { headers: Object.assign({ 'User-Agent': UA }, headers || {}), timeout: 12000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), ms: Date.now() - started }));
    });
    req.on('timeout', () => { req.destroy(new Error('timeout after 12s')); });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message, ms: Date.now() - started }));
  });
}

async function main() {
  const list = only ? SOURCES.filter((s) => s.label.toLowerCase().includes(only) || s.league.toLowerCase().includes(only)) : SOURCES;
  if (!list.length) { console.log(`probe-roster-sources: nothing matches --only ${only}`); process.exit(1); }
  console.log(`probe-roster-sources: ${list.length} source(s), from ${require('os').hostname()}\n`);
  const verdict = new Map();   // league -> { tier, ok }
  for (const s of list) {
    const r = await get(s.url, s.headers);
    let note;
    let usable = false;
    if (r.error) note = `ERROR ${r.error}`;
    else if (r.status !== 200) note = `HTTP ${r.status}` + (r.body.slice(0, 60).replace(/\s+/g, ' ') ? ' ' + JSON.stringify(r.body.slice(0, 60).replace(/\s+/g, ' ')) : '');
    else if (s.html) { note = s.check(); usable = true; }
    else {
      try { note = s.check(JSON.parse(r.body)); usable = !/^no |^0 /.test(note); }
      catch (_) { note = 'not JSON: ' + JSON.stringify(r.body.slice(0, 60).replace(/\s+/g, ' ')); }
    }
    console.log(`${usable ? ' ok ' : 'FAIL'}  ${s.label.padEnd(24)} ${String(r.status).padStart(3)}  ${String(r.body.length).padStart(7)}B  ${String(r.ms).padStart(5)}ms  ${note}`);
    const v = verdict.get(s.league) || { tier: s.tier, ok: true, any: false };
    v.any = true; v.ok = v.ok && usable;
    verdict.set(s.league, v);
  }
  console.log('\nWHAT THE LOOKUP CAN LEAN ON FROM HERE:');
  for (const [league, v] of verdict) {
    const tier = v.tier === 'SEARCH' ? 'SEARCH' : (v.ok ? v.tier : 'SEARCH (feed did not answer)');
    console.log(`  ${league.padEnd(18)} ${tier}`);
  }
  console.log('\nDone.');
  process.exitCode = 0;
}
main().catch((e) => { console.error('probe-roster-sources: THREW', e); process.exit(1); });
