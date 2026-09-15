// server/services/athleteLookup.js  v2
// Multi-stage NCAA athlete entity resolution engine
//
// PIPELINE:
//   Stage 1  — Input normalization (school aliases, sport variants)
//   Stage 2A — ESPN Live Roster (football, basketball, baseball, volleyball only)
//   Stage 2B — AI Lookup (primary source for softball/soccer/unsupported sports)
//   Stage 3  — Merge, rank, return ≤3 candidates with confidence scores
//
// CASE MATRIX:
//   School known + ESPN sport  → ESPN roster match  + AI enrichment
//   School known + non-ESPN    → AI school-specific  (high precision prompt)
//   No school + any sport      → AI multi-candidate  (returns top 3 schools)
//
// CONFIDENCE SCALE:
//   95-100  auto-select (ESPN confirmed + AI verified, exact name match)
//   80-94   strong match — show picker, first pre-selected
//   60-79   possible match — show picker for user to confirm
//   < 60    no reliable match

'use strict';

const { getRoster, resolveESPNSportPath } = require('./university/ESPNRosterService');

// ── Sports ESPN API actually supports (verified 2025) ──────────────────────
// Other sports (softball, soccer, lacrosse, track, etc.) return 404 from ESPN.
// ── THE LOOKUP MODEL ─────────────────────────────────────────────────────────
// Extraction: read a roster or a recruiting page the search returned and copy
// the fields off it. The same job the contact ladder's sources do on Haiku,
// and it ran on Sonnet only because it was written before the ladder was.
// Overridable without a deploy so a bad night can be pinned back.
const LOOKUP_MODEL = process.env.LOOKUP_MODEL || 'claude-haiku-4-5-20251001';
const Ledger = require('./aiLedger');

const ESPN_SUPPORTED_SPORTS = new Set([
  'football',
  "men's basketball",
  "women's basketball",
  'baseball',
  "women's volleyball",
]);

// ── School Name Aliases → ESPN-recognizable names ─────────────────────────
const SCHOOL_ALIASES = {
  'uconn': 'Connecticut',
  'university of connecticut': 'Connecticut',
  'ucf': 'UCF',
  'usc': 'USC',
  'ucla': 'UCLA',
  'lsu': 'LSU',
  'byu': 'BYU',
  'tcu': 'TCU',
  'smu': 'SMU',
  'osu': 'Ohio State',
  'ohio state': 'Ohio State',
  'ole miss': 'Mississippi',
  'unc': 'North Carolina',
  'nc state': 'NC State',
  'n.c. state': 'NC State',
  'vt': 'Virginia Tech',
  'virginia tech': 'Virginia Tech',
  'pitt': 'Pittsburgh',
  'penn state': 'Penn State',
  'psu': 'Penn State',
  'texas a&m': 'Texas A&M',
  'a&m': 'Texas A&M',
  'miami fl': 'Miami',
  'miami (fl)': 'Miami',
  'miami oh': 'Miami (OH)',
  'miami (oh)': 'Miami (OH)',
  'fsu': 'Florida State',
  'florida state': 'Florida State',
  'uk': 'Kentucky',
  'ku': 'Kansas',
  'iu': 'Indiana',
  'mu': 'Missouri',
  'msu': 'Michigan State',
  'asu': 'Arizona State',
  'wsu': 'Washington State',
  'wvu': 'West Virginia',
  'ttu': 'Texas Tech',
  'ou': 'Oklahoma',
  'vcu': 'VCU',
  'unlv': 'UNLV',
  'unm': 'New Mexico',
  'utep': 'UTEP',
  'utsa': 'UTSA',
  'usf': 'South Florida',
  'umass': 'UMass',
  'unt': 'North Texas',
  'uab': 'UAB',
  'uncw': 'UNC Wilmington',
  'fiu': 'Florida International',
  'fau': 'Florida Atlantic',
  'siu': 'Southern Illinois',
  'slu': 'Saint Louis',
  'uga': 'Georgia',
  'uva': 'Virginia',
  'umd': 'Maryland',
  'bu': 'Boston University',
  'bc': 'Boston College',
  'gw': 'George Washington',
  'du': 'Denver',
  'bama': 'Alabama',
  'roll tide': 'Alabama',
};

// ── Sport Normalization → canonical sport key ─────────────────────────────
const SPORT_NORMALIZE = {
  'football': 'football',
  'cfb': 'football',
  'basketball': "men's basketball",
  'mens basketball': "men's basketball",
  "men's basketball": "men's basketball",
  'mbb': "men's basketball",
  'womens basketball': "women's basketball",
  "women's basketball": "women's basketball",
  'wbb': "women's basketball",
  'baseball': 'baseball',
  'bsb': 'baseball',
  'softball': 'softball',
  'sb': 'softball',
  "women's softball": 'softball',
  'soccer': "women's soccer",
  "women's soccer": "women's soccer",
  'womens soccer': "women's soccer",
  "men's soccer": "men's soccer",
  'mens soccer': "men's soccer",
  'volleyball': "women's volleyball",
  "women's volleyball": "women's volleyball",
  'womens volleyball': "women's volleyball",
  'lacrosse': "men's lacrosse",
  "men's lacrosse": "men's lacrosse",
  "women's lacrosse": "women's lacrosse",
  'track': 'track & field',
  'track & field': 'track & field',
  'swimming': 'swimming',
  'gymnastics': 'gymnastics',
  'wrestling': 'wrestling',
  'golf': 'golf',
  'tennis': 'tennis',
  'field hockey': 'field hockey',
  'cross country': 'cross country',
};

// ── Eligibility year → label ──────────────────────────────────────────────
function espnYearToEligibility(yr) {
  return { Fr: 'Freshman', So: 'Sophomore', Jr: 'Junior', Sr: 'Senior', Gr: 'Grad Transfer' }[yr] || yr || null;
}

// ── School tier inference from known programs ─────────────────────────────
function inferSchoolTier(name) {
  const n = (name || '').toLowerCase();
  const elite = ['alabama', 'georgia', 'ohio state', 'michigan', 'clemson', 'lsu', 'oklahoma', 'notre dame', 'texas', 'penn state', 'oregon', 'florida', 'usc', 'ucla'];
  if (elite.some(p => n.includes(p))) return 'p4-top10';
  const p4 = ['sec', 'big ten', 'big 12', 'acc', 'kentucky', 'tennessee', 'missouri', 'iowa', 'purdue', 'maryland', 'rutgers', 'illinois', 'minnesota', 'nebraska', 'northwestern', 'indiana', 'michigan state', 'wisconsin', 'kansas', 'baylor', 'oklahoma state', 'kansas state', 'iowa state', 'west virginia', 'texas tech', 'cincinnati', 'houston', 'ucf', 'utah', 'colorado', 'arizona', 'arizona state', 'washington state', 'oregon state', 'cal ', 'stanford', 'nc state', 'wake forest', 'virginia', 'virginia tech', 'boston college', 'pitt', 'louisville', 'duke', 'north carolina', 'miami', 'florida state', 'georgia tech', 'syracuse'];
  if (p4.some(p => n.includes(p))) return 'p4-mid';
  return 'mid-mid';
}

// ── Input normalization ──────────────────────────────────────────────────
function normalizeName(name) {
  return (name || '').trim().replace(/[''`]/g, "'").replace(/\s+/g, ' ').toLowerCase();
}

function normalizeSchool(school) {
  if (!school) return null;
  const key = school.trim().toLowerCase().replace(/[^a-z0-9\s&().'-]/g, '').replace(/\s+/g, ' ');
  return SCHOOL_ALIASES[key] || school.trim();
}

function normalizeSport(sport) {
  if (!sport) return null;
  const key = (sport || '').trim().toLowerCase();
  if (key in SPORT_NORMALIZE) return SPORT_NORMALIZE[key];
  for (const [k, v] of Object.entries(SPORT_NORMALIZE)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return sport;
}

// ── Name Match Scoring (0–35) ────────────────────────────────────────────
function nameMatchScore(query, candidate) {
  if (!query || !candidate) return 0;
  const q = normalizeName(query);
  const c = normalizeName(candidate);
  if (q === c) return 35;

  const qClean = q.replace(/[^a-z]/g, '');
  const cClean = c.replace(/[^a-z]/g, '');
  if (qClean === cClean) return 33; // punctuation/spacing variant

  const qW = q.split(/\s+/).filter(Boolean);
  const cW = c.split(/\s+/).filter(Boolean);
  if (!qW.length || !cW.length) return 0;

  const qFirst = qW[0], qLast = qW[qW.length - 1];
  const cFirst = cW[0], cLast = cW[cW.length - 1];

  if (qFirst === cFirst && qLast === cLast) return 32;   // full match (middle name diff)
  if (qLast === cLast && qFirst[0] === cFirst[0]) return 25; // last + initial
  if (qLast === cLast) return 18;                         // last name only
  if (qFirst === cFirst && qFirst.length > 2) return 15; // first name only
  for (const qw of qW) for (const cw of cW) if (qw === cw && qw.length > 2) return 12;
  if (cClean.includes(qClean) || qClean.includes(cClean)) return 10;
  return 0;
}

// ── Loose school name comparison ─────────────────────────────────────────
function schoolsMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => s.toLowerCase()
    .replace(/\b(university of|university|college|state university|the )\b/g, '')
    .replace(/[^a-z0-9]/g, '').trim();
  const ca = clean(a), cb = clean(b);
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

// ── Stage 2A: ESPN Roster (football/basketball/baseball/volleyball only) ──
async function espnStage(normName, normSchool, normSport) {
  if (!normSchool || !normSport) return [];
  if (!ESPN_SUPPORTED_SPORTS.has(normSport)) return []; // skip silently

  try {
    const result = await getRoster(normSchool, normSport);
    if (!result.athletes?.length) return [];

    const teamName = result.team?.name || normSchool;
    return result.athletes
      .map(a => {
        const ns = nameMatchScore(normName, a.name);
        if (ns === 0) return null;
        return {
          name: a.name, school: teamName,
          sport: normSport, position: a.position || null,
          year: espnYearToEligibility(a.year),
          height: a.height || null, weight: a.weight || null,
          hometown: a.hometown || null, espn_id: a.espn_id || null,
          source: 'espn-roster', sourceLabel: 'ESPN Live Roster',
          confidence: Math.min(96, 60 + ns), _ns: ns,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b._ns - a._ns)
      .slice(0, 5);
  } catch (e) {
    console.warn('[lookup] ESPN error:', e.message);
    return [];
  }
}

// ── Stage 2B: Web Search + Claude lookup ─────────────────────────────────
// Uses the web_search_20250305 tool so Claude reads live, real pages rather
// than recalling potentially-stale training data.  Falls back to null (never
// crashes) when search is unavailable.
async function webSearchStage(normName, normSchool, normSport, normPosition, normYear, espnTop) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Build a targeted search query
  let searchContext;
  if (espnTop) {
    // Enrich a confirmed ESPN athlete — look for social media, stats, career notes
    searchContext =
      `${espnTop.name} ${espnTop.school} ${espnTop.sport} athlete stats social media NIL`;
  } else if (normSchool && normSport) {
    searchContext =
      `"${normName}" ${normSchool} ${normSport} athlete site:espn.com OR site:247sports.com OR site:on3.com OR site:rivals.com`;
  } else if (normSchool) {
    searchContext = `"${normName}" ${normSchool} college athlete`;
  } else if (normSport) {
    searchContext = `"${normName}" ${normSport} college athlete 2024 2025`;
  } else {
    searchContext = `"${normName}" NCAA college athlete`;
  }
  if (normYear && !espnTop) searchContext += ` ${normYear}`;

  const athleteContext = espnTop
    ? `Confirmed athlete on ESPN roster:\nName: ${espnTop.name} | School: ${espnTop.school} | Sport: ${espnTop.sport} | Position: ${espnTop.position || '?'} | Year: ${espnTop.year || '?'}\n\nSearch for their stats, social media following, awards, and career notes.`
    : `Search for this college athlete:\nName: ${normName}\nSport: ${normSport || 'unknown'}\nSchool: ${normSchool || 'unknown'}${normPosition ? '\nPosition: ' + normPosition : ''}${normYear ? '\nYear: ' + normYear : ''}`;

  const userPrompt = `${athleteContext}

Search query to use: ${searchContext}

After searching, return ONLY a valid JSON object — no markdown, no explanation:
{
  "found": true or false,
  "confidenceScore": 0-100,
  "athletes": [
    {
      "name": "full name",
      "school": "school name",
      "sport": "sport",
      "position": "position or null",
      "year": "Fr/So/Jr/Sr/Grad Transfer or null",
      "hometown": "city, state or null",
      "jersey_number": "number or null",
      "instagram": 0,
      "tiktok": 0,
      "engagement": 0,
      "schoolTier": "p4-top10/p4-mid/mid-mid/etc or null",
      "stats": "career stats string or null",
      "notes": "awards, transfer history, recruiting rank or null",
      "interest_tags": ["only when their bio/socials clearly show an interest, choose from exactly: supplements, creatine, protein, apparel, gyms, coffee, pizza, smoothies, energy drinks, snacks, restaurants, skincare, haircare, makeup, fragrance, streetwear, sneakers, accessories, dealerships, detailing, tires, chiropractic, physical therapy, mental health, recovery, gaming, apps, hunting, fishing, camping, banks, credit unions, insurance, local events, nonprofits, youth sports. Empty array when unsure, never guess"],
      "previousSchool": "transfer source school or null",
      "source": "full URL of the page you found this on",
      "sourceLabel": "ESPN or 247Sports or On3 or Rivals or School Site"
    }
  ],
  "searchNote": "one sentence about what you found or why nothing matched"
}

RULES:
- Only include athletes you can verify from actual search results
- Never fabricate or guess athlete data — use null for anything not found in search results
- If multiple athletes share this name at different schools, list all of them
- If nothing found, return found: false with empty athletes array
- confidenceScore: 85-100 if confirmed on ESPN/official site, 60-84 if found on recruiting site, 40-59 if limited info, below 40 if very uncertain`;

  try {
    const _t0 = Date.now();
    const response = await client.messages.create({
      model: LOOKUP_MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You are an athlete data lookup assistant. Search for real, verified information about college athletes.
Only return information confirmed by actual search results. Never hallucinate athlete data.
Prefer ESPN, 247Sports, On3, Rivals, and official school athletic department websites as sources.`,
      messages: [{ role: 'user', content: userPrompt }],
    });

    // This client bypasses ai.js, so the ledger row is written here.
    Ledger.record(response, { model: LOOKUP_MODEL, ms: Date.now() - _t0, ctx: { site: 'lookup.college' } });
    // Extract text from all text-type content blocks
    const textContent = response.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    if (!textContent) return null;

    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;

    const parsed = JSON.parse(jsonMatch[0]);
    return parsed;
  } catch (e) {
    console.warn('[lookup] Web search failed:', e.message);
    return null;
  }
}

// ── PRO: which league to search, from the sport ──────────────────────────
// The lookup for a pro searches league rosters, not ESPN's college pages and
// not the recruiting sites. The sport picks the league; an unknown sport
// searches "professional" and lets the roster page say which league.
function leagueFor(sport) {
  const s = String(sport || '').toLowerCase();
  if (!s) return null;
  if (/football/.test(s)) return 'NFL';
  // A sport typed without a gender names BOTH leagues. "Soccer" used to be
  // normalised to "women's soccer" (the college normaliser's default, where
  // ESPN's women's pages are the common case) and searched as NWSL only, so
  // a man on New York City FC was reported as not found.
  if (/women.*basketball|wnba/.test(s)) return 'WNBA';
  if (/men.*basketball|\bnba\b/.test(s)) return 'NBA';
  if (/basketball/.test(s)) return 'NBA or WNBA';
  if (/baseball/.test(s)) return 'MLB';
  if (/women.*hockey|\bpwhl\b/.test(s)) return 'PWHL';
  if (/hockey/.test(s)) return 'NHL or PWHL';
  if (/women.*soccer|nwsl/.test(s)) return 'NWSL';
  if (/men.*soccer|\bmls\b/.test(s)) return 'MLS';
  if (/soccer/.test(s)) return 'MLS or NWSL';
  if (/golf/.test(s)) return 'PGA Tour or LPGA';
  if (/tennis/.test(s)) return 'ATP or WTA';
  if (/softball/.test(s)) return 'AUSL';
  if (/volleyball/.test(s)) return 'Pro Volleyball Federation or LOVB';
  return null;
}

// ── Stage P: Web search for a PROFESSIONAL athlete ───────────────────────
// Same tool, same "only what the search actually returned" rule as the
// college stage, but the query is the roster and the answer is what a pitch
// needs about a pro: position, team, city and what they are known for.
// Numeric stats are not requested as structured fields. Nothing in this
// codebase reads pro stats from anywhere; a one-line "known for" is what the
// writer uses, and it is editable on the form.
async function proSearchStage(normName, team, city, normSport, normPosition) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const league = leagueFor(normSport);
  const searchContext = [`"${normName}"`, team || '', league || 'professional', 'roster'].filter(Boolean).join(' ');
  const userPrompt = `Search for this PROFESSIONAL athlete on a league or team roster:
Name: ${normName}
Sport: ${normSport || 'unknown'}${league ? ' (' + league + ')' : ''}
Team: ${team || 'unknown'}${city ? '\nCity: ' + city : ''}${normPosition ? '\nPosition: ' + normPosition : ''}

Search query to use: ${searchContext}

After searching, return ONLY a valid JSON object — no markdown, no explanation:
{
  "found": true or false,
  "confidenceScore": 0-100,
  "athletes": [
    {
      "name": "full name",
      "team": "current team, as the roster names it",
      "league": "NFL, NBA, WNBA, MLB, NHL, MLS, NWSL or other",
      "city": "the team's home city as 'City, ST' or null",
      "sport": "sport",
      "position": "position or null",
      "knownFor": "one line on what they are known for — awards, a signature season, a role — only from what you found, or null",
      "hometown": "city, state or null",
      "instagram": 0,
      "tiktok": 0,
      "engagement": 0,
      "notes": "career notes, previous teams, draft year or null",
      "interest_tags": ["only when their bio/socials clearly show an interest, choose from exactly: supplements, creatine, protein, apparel, gyms, coffee, pizza, smoothies, energy drinks, snacks, restaurants, skincare, haircare, makeup, fragrance, streetwear, sneakers, accessories, dealerships, detailing, tires, chiropractic, physical therapy, mental health, recovery, gaming, apps, hunting, fishing, camping, banks, credit unions, insurance, local events, nonprofits, youth sports. Empty array when unsure, never guess"],
      "source": "full URL of the page you found this on",
      "sourceLabel": "NFL.com or NBA.com or MLB.com or NHL.com or MLSsoccer.com or ESPN or Team Site or Other"
    }
  ],
  "searchNote": "one sentence about what you found or why nothing matched"
}

RULES:
- Only include athletes you can verify from actual search results
- Never fabricate or guess athlete data — use null for anything not found in search results
- If multiple professional athletes share this name, list all of them
- A college athlete is NOT a match. If the only person by this name is on a college roster, return found: false and say so in searchNote
- If nothing found, return found: false with empty athletes array
- confidenceScore: 85-100 if confirmed on a league or team site, 60-84 if found on ESPN or a major outlet, 40-59 if limited info, below 40 if very uncertain`;

  try {
    const _t0 = Date.now();
    const response = await client.messages.create({
      model: LOOKUP_MODEL,
      max_tokens: 1500,
      tools: [{ type: 'web_search_20250305', name: 'web_search' }],
      system: `You are an athlete data lookup assistant. Search for real, verified information about professional athletes.
Only return information confirmed by actual search results. Never hallucinate athlete data.
Prefer NFL.com, NBA.com, WNBA.com, MLB.com, NHL.com, MLSsoccer.com, official team sites and ESPN as sources.`,
      messages: [{ role: 'user', content: userPrompt }],
    });
    Ledger.record(response, { model: LOOKUP_MODEL, ms: Date.now() - _t0, ctx: { site: 'lookup.pro' } });
    const textContent = response.content.filter(b => b.type === 'text').map(b => b.text).join('');
    if (!textContent) return null;
    const jsonMatch = textContent.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch (e) {
    console.warn('[lookup] Pro web search failed:', e.message);
    return null;
  }
}

// ── Flatten a candidate to legacy flat fields ────────────────────────────
function flattenCandidate(c) {
  return {
    found: true,
    name: c.name, school: c.school, sport: c.sport,
    position: c.position, year: c.year, stats: c.stats,
    height: c.height, weight: c.weight, hometown: c.hometown,
    instagram: c.instagram || 0, tiktok: c.tiktok || 0,
    engagement: c.engagement || 0,
    schoolTier: c.schoolTier || null,
    notes: c.notes || null, previousSchool: c.previousSchool || null,
    interestTags: c.interestTags || [],
    confidence: c.confidence, source: c.source, sourceLabel: c.sourceLabel,
    // Pro fields, null on a college candidate.
    athleteType: c.athleteType || 'college',
    team: c.team || null, city: c.city || null, league: c.league || null,
    knownFor: c.knownFor || null,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function resolveAthlete(ai, { name, school, sport, position, year, athleteType, team, city }) {
  const normName     = normalizeName(name);
  const normSchool   = normalizeSchool(school);
  const normSport    = normalizeSport(sport);
  const normPosition = (position || '').trim() || null;
  const normYear     = (year || '').trim() || null;
  const espnOk       = normSport && ESPN_SUPPORTED_SPORTS.has(normSport);

  // ── A PRO: league rosters, no ESPN college stage, no school constraint ──
  if (athleteType === 'pro') {
    const normTeam = String(team || '').trim() || null;
    const normCity = String(city || '').trim() || null;
    // THE SPORT AS TYPED, not normalised. normalizeSport is the college
    // normaliser: it turns "soccer" into "women's soccer" and "basketball"
    // into "men's basketball" because that is what ESPN's college pages
    // need. A pro search must not inherit that guess -- leagueFor names both
    // leagues for a bare sport and the roster page says which.
    const proSport = String(sport || '').trim().toLowerCase().replace(/\s+/g, ' ') || null;
    const pro = await proSearchStage(normName, normTeam, normCity, proSport, normPosition);
    const candidates = [];
    if (pro && pro.found && Array.isArray(pro.athletes)) {
      const baseConf = pro.confidenceScore || 65;
      for (const a of pro.athletes) {
        if (!a || !a.name) continue;
        candidates.push({
          athleteType:  'pro',
          name:         a.name,
          team:         a.team || normTeam,
          league:       a.league || leagueFor(proSport),
          city:         a.city || normCity,
          school:       null, year: null, schoolTier: null,
          sport:        a.sport || proSport || sport,
          position:     a.position || normPosition || null,
          knownFor:     a.knownFor || null,
          stats:        a.knownFor || null,   // the form's stats box holds "known for" on a pro
          hometown:     a.hometown || null,
          instagram:    a.instagram || 0,
          tiktok:       a.tiktok || 0,
          engagement:   a.engagement || 0,
          notes:        a.notes || null,
          interestTags: Array.isArray(a.interest_tags) ? a.interest_tags.filter(t => typeof t === 'string').slice(0, 10) : [],
          sourceUrl:    a.source || null,
          source:       'web-search',
          sourceLabel:  a.sourceLabel || 'Web Search',
          confidence:   baseConf,
        });
      }
    }
    if (!candidates.length) {
      return { found: false, candidates: [],
        message: (pro && pro.searchNote) || 'No verified professional athlete found. Please fill in details manually.' };
    }
    candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
    candidates[0].best = true;
    const autoSelect = candidates[0].confidence >= 95 && candidates.length === 1;
    return { found: true, candidates: candidates.slice(0, 3), autoSelect, espnSupported: false,
      ...(autoSelect ? flattenCandidate(candidates[0]) : {}) };
  }

  // Stage 2A — ESPN live roster (football/basketball/baseball/volleyball + known school)
  const espnCandidates = await espnStage(normName, normSchool, normSport);
  const topESPN = espnCandidates[0] || null;

  // Stage 2B — Web search + Claude (always runs; enriches ESPN or finds athletes independently)
  const searchResult = await webSearchStage(normName, normSchool, normSport, normPosition, normYear, topESPN);

  // ── Merge candidates ───────────────────────────────────────────────────
  let candidates = [];

  if (topESPN) {
    // ESPN confirmed — try to enrich with web search data (social, stats, notes)
    const merged = { ...topESPN };
    const enriched = searchResult?.athletes?.[0];
    if (enriched) {
      merged.stats          = enriched.stats || null;
      merged.instagram      = enriched.instagram || 0;
      merged.tiktok         = enriched.tiktok || 0;
      merged.engagement     = enriched.engagement || 0;
      merged.schoolTier     = enriched.schoolTier || inferSchoolTier(topESPN.school);
      merged.notes          = enriched.notes || null;
      merged.previousSchool = enriched.previousSchool || null;
      merged.sourceUrl      = enriched.source || null;
      merged.year           = topESPN.year    || enriched.year;
      merged.position       = topESPN.position || enriched.position;
      merged.confidence     = Math.min(99, topESPN.confidence + 4);
      merged.source         = 'espn-roster+web';
      merged.sourceLabel    = 'ESPN Live Roster + Web Verified';
    } else {
      merged.schoolTier = inferSchoolTier(topESPN.school);
    }
    candidates.push(merged);
    // Additional ESPN candidates (lower-ranked name matches)
    for (const c of espnCandidates.slice(1)) {
      if (c._ns >= 15) candidates.push({ ...c, schoolTier: inferSchoolTier(c.school) });
    }

  } else if (searchResult?.found && searchResult.athletes?.length) {
    // Web search is the primary source
    const baseConf = searchResult.confidenceScore || 65;
    for (const a of searchResult.athletes) {
      // Validate school constraint when we know the school
      if (normSchool && a.school && !schoolsMatch(a.school, normSchool)) continue;

      const conf = baseConf;
      candidates.push({
        name:          a.name,
        school:        a.school || normSchool,
        sport:         a.sport  || normSport || sport,
        position:      a.position     || normPosition || null,
        year:          a.year         || normYear || null,
        stats:         a.stats        || null,
        hometown:      a.hometown     || null,
        instagram:     a.instagram    || 0,
        tiktok:        a.tiktok       || 0,
        engagement:    a.engagement   || 0,
        schoolTier:    a.schoolTier   || inferSchoolTier(a.school || normSchool),
        notes:         a.notes        || null,
        interestTags:  Array.isArray(a.interest_tags) ? a.interest_tags.filter(t => typeof t === 'string').slice(0, 10) : [],
        previousSchool: a.previousSchool || null,
        sourceUrl:     a.source       || null,
        source:        'web-search',
        sourceLabel:   a.sourceLabel  || 'Web Search',
        confidence:    conf,
      });
    }
  }

  if (!candidates.length) {
    return {
      found: false,
      candidates: [],
      message: searchResult?.searchNote || 'No verified athlete found. Please fill in details manually.',
    };
  }

  // Sort by confidence descending, mark the best
  candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  candidates[0].best = true;

  // autoSelect: ESPN match ≥95 confidence with single result → fill form directly
  const autoSelect = candidates[0].confidence >= 95 && candidates.length === 1;

  return {
    found: true,
    candidates: candidates.slice(0, 3),
    autoSelect,
    espnSupported: espnOk,
    ...(autoSelect ? flattenCandidate(candidates[0]) : {}),
  };
}

module.exports = { resolveAthlete, normalizeName, normalizeSchool, normalizeSport, nameMatchScore, ESPN_SUPPORTED_SPORTS, leagueFor, proSearchStage };
