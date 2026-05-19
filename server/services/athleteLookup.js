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

// ── Stage 2B: AI Lookup — four specialized prompts ───────────────────────
//
// We use DIFFERENT prompts depending on what we know:
//   (a) school + ESPN-supported sport  → enrich an ESPN match (or confirm)
//   (b) school + non-ESPN sport        → school-specific roster lookup
//   (c) no school + any sport          → multi-candidate search across all schools
//   (d) no school + no sport           → broad search, return candidates

async function aiStage(ai, normName, normSchool, normSport, espnTop) {
  let prompt;

  if (espnTop) {
    // Case (a) — enrich a confirmed ESPN match with stats, social, career context
    prompt =
      `NCAA ATHLETE CONFIRMED ON ROSTER:\n` +
      `Name: ${espnTop.name} | School: ${espnTop.school} | Sport: ${espnTop.sport}\n` +
      `Position: ${espnTop.position || '?'} | Year: ${espnTop.year || '?'}\n\n` +
      `Provide career stats, social media estimates, school tier, awards, and transfer history for this confirmed athlete.\n` +
      `Return JSON (null for anything you cannot verify):\n` +
      `{"found":true,"name":"${espnTop.name}","school":"${espnTop.school}","sport":"${espnTop.sport}","position":"${espnTop.position || ''}","year":"${espnTop.year || ''}","stats":"career stats — format: 2023 at School: stats | 2024: stats","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"p4-top10|p4-top25|p4-mid|p4-lower|highmajor-top|highmajor-mid|mid-top|mid-mid|mid-lower|lowmajor-top|lowmajor-lower","notes":"awards, recruiting rank, draft projection, transfer history","previousSchool":null,"confidence":90}`;

  } else if (normSchool) {
    // Case (b) — school known, non-ESPN sport — precise roster lookup
    const sportLabel = normSport || 'sport';
    prompt =
      `You are an NCAA sports database with comprehensive knowledge of college rosters through the 2025-26 season.\n\n` +
      `LOOKUP: Is "${normName}" on ${normSchool}'s ${sportLabel} roster?\n\n` +
      `RULES:\n` +
      `- Return data ONLY if you are confident this specific athlete plays at ${normSchool}\n` +
      `- Sport MUST be ${sportLabel} — reject if you find them in a different sport\n` +
      `- Do NOT fabricate stats. Use null for anything unverifiable.\n` +
      `- If you cannot confirm with ≥75% confidence, return {"found":false}\n\n` +
      `Return JSON:\n` +
      `{"found":true,"name":"full name","school":"${normSchool}","sport":"${sportLabel}","position":"","year":"Fr|So|Jr|Sr|Grad Transfer","stats":"career stats: 2024: .302 BA, 12 HR | 2025: ...","height":"5-8","weight":null,"hometown":"city, state","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"p4-mid","notes":"awards, recruiting rank, high school, transfer history","previousSchool":null,"confidence":85}\n\n` +
      `confidence: 85-95 if certain, 75-84 if fairly sure, return {"found":false} if uncertain or cannot verify.\n` +
      `Return ONLY JSON. No markdown.`;

  } else if (normSport) {
    // Case (c) — no school, sport known — multi-candidate search
    const sportLabel = normSport;
    prompt =
      `You are an NCAA ${sportLabel} expert with comprehensive knowledge of Division I and II rosters through 2025-26.\n\n` +
      `Search your knowledge for ALL college ${sportLabel} athletes named "${normName}".\n\n` +
      `RULES:\n` +
      `- Only include athletes you can confirm with ≥70% confidence\n` +
      `- If multiple athletes have this name at different schools, list ALL of them\n` +
      `- Do NOT fabricate athletes — if you are uncertain, return {"found":false,"candidates":[]}\n` +
      `- Each candidate must have a specific school\n\n` +
      `Return JSON:\n` +
      `{"found":true,"candidates":[{"name":"full name","school":"school name","sport":"${sportLabel}","position":"","year":"Fr|So|Jr|Sr|Grad Transfer","stats":"career stats","hometown":"city, state","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"p4-mid","notes":"key facts","previousSchool":null,"confidence":82}]}\n\n` +
      `If you find nothing, return: {"found":false,"candidates":[]}\n` +
      `Return ONLY JSON. No markdown.`;

  } else {
    // Case (d) — no school, no sport — broadest search
    prompt =
      `You are an NCAA sports database. Search for college athletes named "${normName}" across all Division I and II programs and sports.\n\n` +
      `RULES:\n` +
      `- Return up to 3 candidates across potentially different schools/sports\n` +
      `- Only include athletes you can confirm with ≥70% confidence\n` +
      `- Do NOT fabricate athletes\n\n` +
      `Return JSON:\n` +
      `{"found":true,"candidates":[{"name":"","school":"","sport":"","position":"","year":"","stats":"","hometown":"","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"","notes":"","previousSchool":null,"confidence":75}]}\n\n` +
      `Return {"found":false,"candidates":[]} if you have no confident match.\n` +
      `Return ONLY JSON. No markdown.`;
  }

  try {
    const raw     = await ai.oneShot(prompt,
      'You are a precise NCAA sports database. Return only verified facts. Never fabricate athletes or statistics. Return only valid JSON.', 2000);
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const obj = JSON.parse(match[0]);

    // Validate school constraint for cases (a) and (b)
    if (normSchool && obj.school && !schoolsMatch(obj.school, normSchool) && !espnTop) {
      console.warn(`[lookup] AI school mismatch: got "${obj.school}", expected "${normSchool}"`);
      return null;
    }

    return obj;
  } catch (e) {
    console.warn('[lookup] AI error:', e.message);
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
    confidence: c.confidence, source: c.source, sourceLabel: c.sourceLabel,
  };
}

// ── Main ────────────────────────────────────────────────────────────────────
async function resolveAthlete(ai, { name, school, sport }) {
  const normName   = normalizeName(name);
  const normSchool = normalizeSchool(school);
  const normSport  = normalizeSport(sport);
  const espnOk     = normSport && ESPN_SUPPORTED_SPORTS.has(normSport);

  // Stage 2A — ESPN (only for supported sports with a known school)
  const espnCandidates = await espnStage(normName, normSchool, normSport);
  const topESPN = espnCandidates[0] || null;

  // Stage 2B — AI (role depends on what ESPN found)
  const aiResult = await aiStage(ai, normName, normSchool, normSport, topESPN);

  // ── Merge candidates ───────────────────────────────────────────────────
  let candidates = [];

  if (topESPN) {
    // Merge AI enrichment into the ESPN match
    const merged = { ...topESPN };
    if (aiResult && aiResult.found !== false) {
      merged.stats          = aiResult.stats || null;
      merged.instagram      = aiResult.instagram || 0;
      merged.tiktok         = aiResult.tiktok    || 0;
      merged.engagement     = aiResult.engagement || 0;
      merged.schoolTier     = aiResult.schoolTier || inferSchoolTier(topESPN.school);
      merged.notes          = aiResult.notes || null;
      merged.previousSchool = aiResult.previousSchool || null;
      merged.year           = topESPN.year    || aiResult.year;
      merged.position       = topESPN.position || aiResult.position;
      merged.confidence     = Math.min(99, topESPN.confidence + 5);
      merged.source         = 'espn-roster+ai';
      merged.sourceLabel    = 'ESPN Live Roster + AI verified';
    } else {
      merged.schoolTier = inferSchoolTier(topESPN.school);
    }
    candidates.push(merged);
    // Other ESPN candidates (lower ranked)
    for (const c of espnCandidates.slice(1)) {
      if (c._ns >= 15) candidates.push({ ...c, schoolTier: inferSchoolTier(c.school) });
    }

  } else if (aiResult && aiResult.found !== false) {
    // AI is the primary source
    if (aiResult.candidates) {
      // Multi-candidate response (no-school cases)
      for (const c of aiResult.candidates) {
        if ((c.confidence || 0) >= 60) {
          candidates.push({
            ...c,
            sport: c.sport || normSport || sport,
            schoolTier: c.schoolTier || inferSchoolTier(c.school),
            source: 'ai-knowledge',
            sourceLabel: 'AI Training Knowledge',
          });
        }
      }
    } else if (aiResult.found) {
      // Single-candidate response (school-specific case)
      candidates.push({
        name: aiResult.name, school: aiResult.school || normSchool,
        sport: aiResult.sport || normSport || sport,
        position: aiResult.position || null, year: aiResult.year || null,
        stats: aiResult.stats || null, height: aiResult.height || null,
        weight: aiResult.weight || null, hometown: aiResult.hometown || null,
        instagram: aiResult.instagram || 0, tiktok: aiResult.tiktok || 0,
        engagement: aiResult.engagement || 0,
        schoolTier: aiResult.schoolTier || inferSchoolTier(aiResult.school || normSchool),
        notes: aiResult.notes || null, previousSchool: aiResult.previousSchool || null,
        source: 'ai-knowledge', sourceLabel: 'AI Training Knowledge',
        confidence: aiResult.confidence || 72,
      });
    }
  }

  if (!candidates.length) return { found: false, candidates: [] };

  // Sort by confidence descending
  candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  candidates[0].best = true;

  // autoSelect: ESPN match with ≥95 confidence → behave exactly like before
  const autoSelect = candidates[0].confidence >= 95 && candidates.length === 1;

  return {
    found: true,
    candidates: candidates.slice(0, 3),
    autoSelect,
    espnSupported: espnOk,
    ...(autoSelect ? flattenCandidate(candidates[0]) : {}),
  };
}

module.exports = { resolveAthlete, normalizeName, normalizeSchool, normalizeSport, nameMatchScore, ESPN_SUPPORTED_SPORTS };
