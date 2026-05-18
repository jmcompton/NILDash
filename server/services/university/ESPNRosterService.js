// server/services/university/ESPNRosterService.js
// Fetches NCAA roster data from ESPN's public JSON API.
//
// WHY ESPN:
//   ESPN's API is the same endpoint their website and apps use.
//   It returns clean structured JSON, requires no authentication,
//   and has no bot protection — it's designed to be consumed programmatically.
//   Coverage: all FBS/FCS football, all D1 basketball, baseball, softball.
//
// FLOW:
//   1. Map sport name → ESPN sport path
//   2. Search for team by school name → get ESPN team ID
//   3. Fetch roster for that team ID
//   4. Normalize to standard athlete shape

'use strict';

const ESPN_BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Maps sport name variants → ESPN API sport path
const ESPN_SPORT_PATHS = {
  'football':              'football/college-football',
  'basketball':            'basketball/mens-college-basketball',
  "men's basketball":      'basketball/mens-college-basketball',
  "women's basketball":    'basketball/womens-college-basketball',
  'baseball':              'baseball/college-baseball',
  'softball':              'softball/college-softball',
  "women's soccer":        'soccer/womens-college-soccer',
  "men's soccer":          'soccer/mens-college-soccer',
  'soccer':                'soccer/womens-college-soccer',
  'volleyball':            'volleyball/womens-college-volleyball',
  "women's volleyball":    'volleyball/womens-college-volleyball',
  'lacrosse':              'lacrosse/mens-college-lacrosse',
  "women's lacrosse":      'lacrosse/womens-college-lacrosse',
};

// Height in inches → "6-2" string
function inchesToDisplay(inches) {
  if (!inches) return null;
  const ft  = Math.floor(inches / 12);
  const rem = Math.round(inches % 12);
  return `${ft}-${rem}`;
}

// Resolve sport name → ESPN path (exact then partial match)
function resolveESPNSportPath(sport) {
  const key = (sport || '').toLowerCase().trim();
  if (ESPN_SPORT_PATHS[key]) return ESPN_SPORT_PATHS[key];
  for (const [k, v] of Object.entries(ESPN_SPORT_PATHS)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return null;
}

// Fetch JSON from ESPN API with a 10-second timeout
async function espnFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: { 'Accept': 'application/json' },
    });
    clearTimeout(timer);
    if (!res.ok) return { ok: false, status: res.status, data: null };
    const data = await res.json();
    return { ok: true, data };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, error: err.message, data: null };
  }
}

// Find a team's ESPN ID by searching school name within a sport
async function findTeamId(sportPath, schoolName) {
  const query  = encodeURIComponent(schoolName.replace(/university|college/gi, '').trim());
  const url    = `${ESPN_BASE}/${sportPath}/teams?limit=1000`;
  const result = await espnFetch(url);

  if (!result.ok || !result.data) return null;

  const teams = result.data?.sports?.[0]?.leagues?.[0]?.teams || [];
  const nameLower = schoolName.toLowerCase();

  // Score each team by how well the name matches
  let best = null, bestScore = 0;
  for (const { team } of teams) {
    const loc  = (team.location  || '').toLowerCase();
    const name = (team.name      || '').toLowerCase();
    const disp = (team.displayName || '').toLowerCase();
    const nick = (team.nickname  || '').toLowerCase();

    let score = 0;
    if (disp === nameLower)                            score = 100;
    else if (loc === nameLower)                        score = 90;
    else if (nameLower.includes(loc) && loc.length > 3) score = 80;
    else if (loc.includes(nameLower.split(' ')[0]))    score = 70;
    else if (nick && nameLower.includes(nick))         score = 60;

    if (score > bestScore) { bestScore = score; best = team; }
  }

  return bestScore >= 60 ? best : null;
}

// Fetch and normalize roster for a given ESPN team ID + sport path
async function fetchRosterById(sportPath, teamId) {
  const url    = `${ESPN_BASE}/${sportPath}/teams/${teamId}/roster`;
  const result = await espnFetch(url);

  if (!result.ok || !result.data) {
    return { athletes: [], error: result.error || `ESPN API returned ${result.status}` };
  }

  const raw = result.data?.athletes || [];

  const athletes = raw
    .filter(a => a.fullName || (a.firstName && a.lastName))
    .map(a => {
      // Parse birth place into hometown string
      const bp       = a.birthPlace || {};
      const hometown = [bp.city, bp.state || bp.country].filter(Boolean).join(', ') || null;

      // Academic year from experience
      const expYears = a.experience?.years;
      const yearMap  = { 0: 'Fr', 1: 'So', 2: 'Jr', 3: 'Sr', 4: 'Gr' };
      const year     = expYears != null ? (yearMap[expYears] || `Yr ${expYears}`) : null;

      return {
        name:     a.fullName || `${a.firstName} ${a.lastName}`.trim(),
        number:   a.jersey   || null,
        position: a.position?.abbreviation || a.position?.name || null,
        year,
        height:   a.height   ? inchesToDisplay(a.height) : null,
        weight:   a.weight   ? Math.round(a.weight)      : null,
        hometown,
        high_school: null,   // ESPN doesn't carry HS data
        major:       null,
        espn_id:  a.id       || null,
      };
    });

  return { athletes };
}

// ── Main export: get roster by school name + sport ────────────────────────
// Returns { athletes[], team, sportPath, error? }
async function getRoster(schoolName, sport) {
  const sportPath = resolveESPNSportPath(sport);
  if (!sportPath) {
    return {
      athletes: [],
      error:    `Sport not supported via ESPN API: "${sport}". Use Paste or CSV import instead.`,
    };
  }

  // 1. Find team
  const team = await findTeamId(sportPath, schoolName);
  if (!team) {
    return {
      athletes: [],
      error:    `Could not find "${schoolName}" in ESPN's ${sport} database. Check the school name or try another sport.`,
    };
  }

  // 2. Fetch roster
  const { athletes, error } = await fetchRosterById(sportPath, team.id);
  if (error) return { athletes: [], team, error };

  return {
    athletes,
    team: {
      id:          team.id,
      name:        team.displayName,
      location:    team.location,
      abbreviation: team.abbreviation,
    },
    sportPath,
  };
}

module.exports = { getRoster, resolveESPNSportPath, ESPN_SPORT_PATHS };
