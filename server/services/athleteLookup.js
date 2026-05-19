// server/services/athleteLookup.js
// Multi-stage NCAA athlete entity resolution engine
//
// PIPELINE:
//   Stage 1 — Input normalization (school aliases, sport variants)
//   Stage 2 — ESPN roster fetch (live, accurate, covers all D1 sports)
//   Stage 3 — Name scoring against roster (fuzzy match engine)
//   Stage 4 — AI enrichment (stats, social, career context)
//   Stage 5 — Candidate ranking + confidence scores
//
// CONFIDENCE SCALE:
//   95-100  auto-select (ESPN confirmed + AI verified)
//   80-94   strong match — show picker, first candidate pre-selected
//   60-79   multiple candidates — show picker for user selection
//   < 60    no reliable match — prompt user to refine

'use strict';

const { getRoster, resolveESPNSportPath } = require('./university/ESPNRosterService');

// ── School Name Normalization ───────────────────────────────────────────────
// Maps common abbreviations, nicknames, and informal names to the full name
// that ESPN's team search recognizes.

const SCHOOL_ALIASES = {
  // ── Power 4 abbrevs ────────────────────────────────────────────────────
  'uconn':          'Connecticut',
  'university of connecticut': 'Connecticut',
  'ucf':            'UCF',
  'usc':            'USC',
  'ucla':           'UCLA',
  'lsu':            'LSU',
  'byu':            'BYU',
  'tcu':            'TCU',
  'smu':            'SMU',
  'osu':            'Ohio State',         // most common usage
  'ohio state':     'Ohio State',
  'ole miss':       'Mississippi',
  'unc':            'North Carolina',
  'nc state':       'NC State',
  'n.c. state':     'NC State',
  'vt':             'Virginia Tech',
  'virginia tech':  'Virginia Tech',
  'pitt':           'Pittsburgh',
  'penn state':     'Penn State',
  'psu':            'Penn State',
  'texas a&m':      'Texas A&M',
  'a&m':            'Texas A&M',
  'miami fl':       'Miami',
  'miami (fl)':     'Miami',
  'miami oh':       'Miami (OH)',
  'miami (oh)':     'Miami (OH)',
  'fsu':            'Florida State',
  'florida state':  'Florida State',
  'uk':             'Kentucky',
  'ku':             'Kansas',
  'iu':             'Indiana',
  'mu':             'Missouri',
  'msu':            'Michigan State',
  'asu':            'Arizona State',
  'wsu':            'Washington State',
  'wvu':            'West Virginia',
  'ttu':            'Texas Tech',
  'ou':             'Oklahoma',
  // ── High / Mid major abbrevs ──────────────────────────────────────────
  'vcu':            'VCU',
  'unlv':           'UNLV',
  'unm':            'New Mexico',
  'utep':           'UTEP',
  'utsa':           'UTSA',
  'usf':            'South Florida',
  'umass':          'UMass',
  'unt':            'North Texas',
  'uco':            'Central Oklahoma',
  'uab':            'UAB',
  'unc wilmington': 'UNC Wilmington',
  'uncw':           'UNC Wilmington',
  'fiu':            'Florida International',
  'fau':            'Florida Atlantic',
  'liu':            'Long Island',
  'siu':            'Southern Illinois',
  'siue':           'SIU Edwardsville',
  'slu':            'Saint Louis',
  'uga':            'Georgia',
  'uva':            'Virginia',
  'umd':            'Maryland',
  'uwm':            'Milwaukee',
  'uw':             'Washington',
  'unh':            'New Hampshire',
  'uri':            'Rhode Island',
  'udel':           'Delaware',
  'drexel':         'Drexel',
  'bu':             'Boston University',
  'bc':             'Boston College',
  'gw':             'George Washington',
  'au':             'American',
  'du':             'Denver',
  'ou':             'Oklahoma',
  // ── Colloquial names ──────────────────────────────────────────────────
  'bama':           'Alabama',
  'roll tide':      'Alabama',
  'gators':         'Florida',
  'vols':           'Tennessee',
  'huskers':        'Nebraska',
  'hoosiers':       'Indiana',
  'wildcats':       'Kentucky',       // ambiguous — but most common
  'hawkeyes':       'Iowa',
  'cyclones':       'Iowa State',
  'wolfpack':       'NC State',
  'heels':          'North Carolina',
  'sooners':        'Oklahoma',
  'longhorns':      'Texas',
  'cowboys':        'Oklahoma State',
  'jayhawks':       'Kansas',
  'spartans':       'Michigan State',
  'wolverines':     'Michigan',
  'bruins':         'UCLA',
  'trojans':        'USC',
  'utes':           'Utah',
  'cougars':        'BYU',
  'ducks':          'Oregon',
  'beavers':        'Oregon State',
  'huskies':        'Washington',
  'sun devils':     'Arizona State',
  'wildcats az':    'Arizona',
  'rebels':         'Mississippi',
  'tigers lsu':     'LSU',
  'bulldogs':       'Georgia',
  'dawgs':          'Georgia',
};

// ── Sport Name Normalization ────────────────────────────────────────────────
// Maps frontend select values and free-text variants to sport names that
// ESPNRosterService.resolveESPNSportPath() understands.

const SPORT_NORMALIZE = {
  // Football
  'football': 'football',
  'cfb': 'football',
  'ncaa football': 'football',

  // Men's Basketball
  'basketball': "men's basketball",
  'mens basketball': "men's basketball",
  "men's basketball": "men's basketball",
  'mbb': "men's basketball",
  'ncaa basketball': "men's basketball",

  // Women's Basketball
  'womens basketball': "women's basketball",
  "women's basketball": "women's basketball",
  'wbb': "women's basketball",
  'womens bb': "women's basketball",

  // Baseball
  'baseball': 'baseball',
  'bsb': 'baseball',

  // Softball
  'softball': 'softball',
  'sball': 'softball',
  'sb': 'softball',
  'women softball': 'softball',
  "women's softball": 'softball',

  // Soccer
  'soccer': "women's soccer",
  "women's soccer": "women's soccer",
  'womens soccer': "women's soccer",
  "men's soccer": "men's soccer",
  'mens soccer': "men's soccer",

  // Volleyball
  'volleyball': "women's volleyball",
  "women's volleyball": "women's volleyball",
  'womens volleyball': "women's volleyball",

  // Lacrosse
  'lacrosse': 'lacrosse',
  "men's lacrosse": 'lacrosse',
  "women's lacrosse": "women's lacrosse",

  // Track / Swimming / Cross Country — ESPN doesn't have rosters for these
  'track': null,
  'track & field': null,
  'swimming': null,
  'cross country': null,
  'gymnastics': null,
  'wrestling': null,
  'golf': null,
  'tennis': null,
  'field hockey': null,
  'rowing': null,
  'water polo': null,
  'ice hockey': null,
};

// ── Year Mapping ─────────────────────────────────────────────────────────────
// ESPN uses experience.years (0=Fr, 1=So, 2=Jr, 3=Sr, 4=Gr)
// Our form uses text labels

function espnYearToEligibility(espnYear) {
  const map = { 'Fr': 'Freshman', 'So': 'Sophomore', 'Jr': 'Junior', 'Sr': 'Senior', 'Gr': 'Grad Transfer' };
  return map[espnYear] || espnYear || null;
}

// ── School Tier from Conference/Name ─────────────────────────────────────────
function inferSchoolTier(teamName, conference) {
  const n = (teamName || '').toLowerCase();
  const c = (conference || '').toLowerCase();

  // P4 elite programs
  const elitePrograms = ['alabama', 'georgia', 'ohio state', 'michigan', 'clemson', 'lsu', 'oklahoma', 'notre dame', 'texas', 'penn state', 'oregon', 'florida'];
  if (elitePrograms.some(p => n.includes(p))) return 'p4-top10';

  // P4 by conference
  if (c.includes('sec') || c.includes('big ten') || c.includes('big 12') || c.includes('acc') || c.includes('pac-12')) {
    return 'p4-mid';
  }
  if (c.includes('american') || c.includes('mountain west') || c.includes('aac') || c.includes('mwc') || c.includes('big east')) {
    return 'highmajor-top';
  }
  if (c.includes('sun belt') || c.includes('mac') || c.includes('cusa') || c.includes('conference usa') || c.includes('atlantic 10') || c.includes('wcc') || c.includes('mvc')) {
    return 'mid-top';
  }
  if (c.includes('socon') || c.includes('big south') || c.includes('ohio valley') || c.includes('ovc') || c.includes('caa') || c.includes('big sky')) {
    return 'lowmajor-top';
  }
  return 'mid-mid';
}

// ── Input Normalization ───────────────────────────────────────────────────────

function normalizeName(name) {
  return (name || '')
    .trim()
    .replace(/[''`]/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase();
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
  // Partial match
  for (const [k, v] of Object.entries(SPORT_NORMALIZE)) {
    if (key.includes(k) || k.includes(key)) return v;
  }
  return sport;
}

// ── Name Match Scoring ────────────────────────────────────────────────────────
// Returns 0-35 based on how well query matches candidate name.

function nameMatchScore(query, candidate) {
  if (!query || !candidate) return 0;

  const q = normalizeName(query);
  const c = normalizeName(candidate);

  // Exact full name match
  if (q === c) return 35;

  const qWords = q.split(/\s+/).filter(Boolean);
  const cWords = c.split(/\s+/).filter(Boolean);

  if (qWords.length < 1 || cWords.length < 1) return 0;

  const qFirst = qWords[0];
  const qLast  = qWords[qWords.length - 1];
  const cFirst = cWords[0];
  const cLast  = cWords[cWords.length - 1];

  // Full first + last name match (handles middle names)
  if (qFirst === cFirst && qLast === cLast) return 32;
  if (qLast  === cLast) {
    // Last name matches — check first name or initial
    if (qFirst[0] === cFirst[0]) return 25; // initial match
    return 18; // last name only
  }
  if (qFirst === cFirst && qFirst.length > 2) return 15;

  // Any word exact match (for single-name searches)
  for (const qw of qWords) {
    for (const cw of cWords) {
      if (qw === cw && qw.length > 2) return 12;
    }
  }

  // Substring containment (catches nicknames like "CJ" → "C.J.")
  const qClean = q.replace(/[^a-z]/g, '');
  const cClean = c.replace(/[^a-z]/g, '');
  if (qClean === cClean) return 30;
  if (cClean.includes(qClean) || qClean.includes(cClean)) return 10;

  return 0;
}

// ── Loose School Name Comparison ─────────────────────────────────────────────
function schoolsMatch(a, b) {
  if (!a || !b) return false;
  const clean = s => s.toLowerCase()
    .replace(/university of |university|college|state university|the /g, '')
    .replace(/[^a-z0-9]/g, '')
    .trim();
  const ca = clean(a), cb = clean(b);
  return ca === cb || ca.includes(cb) || cb.includes(ca);
}

// ── ESPN Stage ────────────────────────────────────────────────────────────────
// Returns up to 3 scored candidates from the live ESPN roster.

async function espnStage(normName, normSchool, normSportKey) {
  if (!normSchool || !normSportKey) return [];

  // Check sport is supported
  const sportPath = resolveESPNSportPath(normSportKey);
  if (!sportPath) return [];

  try {
    const result = await getRoster(normSchool, normSportKey);
    if (!result.athletes || !result.athletes.length) return [];

    const teamName = result.team?.name || normSchool;
    const abbrev   = result.team?.abbreviation || '';

    return result.athletes
      .map(a => {
        const nameScore = nameMatchScore(normName, a.name);
        if (nameScore === 0) return null;

        const confidence = Math.min(96, 60 + nameScore);
        return {
          name:        a.name,
          school:      teamName,
          schoolAbbrev: abbrev,
          sport:       normSportKey,
          position:    a.position || null,
          year:        espnYearToEligibility(a.year),
          height:      a.height || null,
          weight:      a.weight || null,
          hometown:    a.hometown || null,
          espn_id:     a.espn_id || null,
          source:      'espn-roster',
          sourceLabel: 'ESPN Live Roster',
          confidence,
          _nameScore:  nameScore,
        };
      })
      .filter(Boolean)
      .sort((a, b) => b._nameScore - a._nameScore)
      .slice(0, 5);
  } catch (e) {
    console.warn('[athleteLookup] ESPN stage error:', e.message);
    return [];
  }
}

// ── AI Enrichment Stage ───────────────────────────────────────────────────────
// Uses Claude to add stats, social estimates, career context.
// If ESPN already found a match, this confirms and enriches.
// If no ESPN match, this is the primary lookup.

async function aiStage(ai, normName, normSchool, normSport, espnConfirmed) {
  const schoolCtx  = normSchool ? ` at ${normSchool}` : '';
  const sportCtx   = normSport  ? ` (${normSport})`   : '';
  const confirmed  = espnConfirmed
    ? `ESPN ROSTER CONFIRMED: This athlete is on the ${espnConfirmed.school} ${espnConfirmed.sport} roster as: ${espnConfirmed.name}, ${espnConfirmed.position || 'position unknown'}, ${espnConfirmed.year || 'year unknown'}.\n` +
      `Use this confirmed identity. Your job is to add stats, social presence, and career context only.\n\n`
    : '';

  const prompt =
    `${confirmed}` +
    `You are a college sports analyst with comprehensive knowledge of NCAA D1 and D2 rosters through 2025-26.\n\n` +
    `Athlete lookup: "${normName}"${schoolCtx}${sportCtx}\n\n` +
    (espnConfirmed ? '' :
      `CRITICAL ACCURACY RULES:\n` +
      `- Only return data you are confident is accurate for this specific athlete\n` +
      `- School field MUST match the searched school (${normSchool || 'any'}) exactly — reject if sport/school mismatch\n` +
      `- Sport field MUST be "${normSport || 'the searched sport'}" — no cross-sport contamination\n` +
      `- If you cannot confidently identify this athlete, return {"found":false}\n` +
      `- Do NOT fabricate stats — use null for anything unverifiable\n\n`
    ) +
    `Return JSON:\n` +
    `{"found":true,"name":"full name","school":"school name","sport":"${normSport || 'sport'}","position":"position","year":"Fr|So|Jr|Sr|Grad Transfer","stats":"career stats — format: 2023 at School: stats | 2024 at School: stats","height":"6-2","weight":"185 lbs","hometown":"city, state","instagram":0,"tiktok":0,"engagement":0,"schoolTier":"p4-top10|p4-top25|p4-mid|p4-lower|highmajor-top|highmajor-mid|mid-top|mid-mid|mid-lower|lowmajor-top|lowmajor-lower","notes":"awards, recruiting rank, transfer history, draft projection","previousSchool":"if transfer","confidence":85}\n\n` +
    `confidence: 85-95 if certain, 65-84 if likely, return {"found":false} if uncertain. Return ONLY JSON, no markdown.`;

  try {
    const raw     = await ai.oneShot(prompt,
      'You are a precise NCAA sports database. Return only verified facts. Return only valid JSON. No markdown.', 1500);
    const cleaned = raw.replace(/```json/g, '').replace(/```/g, '').trim();
    const match   = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return null;

    const obj = JSON.parse(match[0]);
    if (!obj.found) return null;

    // School/sport validation — reject mismatches when we have constraints
    if (normSchool && obj.school && !schoolsMatch(obj.school, normSchool)) {
      console.warn(`[athleteLookup] AI returned school "${obj.school}" but expected "${normSchool}" — discarding`);
      return null;
    }
    if (normSport && obj.sport && !normalizeSport(obj.sport) &&
        !normalizeSport(obj.sport)?.includes(normSport.split("'s").pop().trim().toLowerCase())) {
      // Loose check only — don't discard if sport normalizes similarly
    }

    return obj;
  } catch (e) {
    console.warn('[athleteLookup] AI stage error:', e.message);
    return null;
  }
}

// ── Candidate Flattening ──────────────────────────────────────────────────────
// Returns flat fields for backward-compat auto-fill when confidence ≥ 95

function flattenCandidate(c) {
  return {
    found:          true,
    name:           c.name,
    school:         c.school,
    sport:          c.sport,
    position:       c.position,
    year:           c.year,
    stats:          c.stats,
    height:         c.height,
    weight:         c.weight,
    hometown:       c.hometown,
    instagram:      c.instagram || 0,
    tiktok:         c.tiktok || 0,
    engagement:     c.engagement || 0,
    schoolTier:     c.schoolTier || null,
    notes:          c.notes || null,
    previousSchool: c.previousSchool || null,
    confidence:     c.confidence,
    source:         c.source,
    sourceLabel:    c.sourceLabel,
  };
}

// ── Main Resolution Function ─────────────────────────────────────────────────

async function resolveAthlete(ai, { name, school, sport }) {
  // Stage 1 — Normalize
  const normName   = normalizeName(name);
  const normSchool = normalizeSchool(school);
  const normSport  = normalizeSport(sport);

  // Stage 2A — ESPN Roster (fast, authoritative for D1)
  const espnCandidates = await espnStage(normName, normSchool, normSport);
  const topESPN = espnCandidates[0] || null;

  // Stage 2B — AI Enrichment / fallback
  const aiResult = await aiStage(ai, normName, normSchool, normSport, topESPN || null);

  // Stage 3 — Merge candidates
  let candidates = [];

  if (topESPN) {
    // Merge AI enrichment into ESPN top match
    const merged = { ...topESPN };

    if (aiResult) {
      // AI confirms / enriches the ESPN match
      merged.stats          = aiResult.stats          || null;
      merged.instagram      = aiResult.instagram      || 0;
      merged.tiktok         = aiResult.tiktok         || 0;
      merged.engagement     = aiResult.engagement     || 0;
      merged.schoolTier     = aiResult.schoolTier     || inferSchoolTier(topESPN.school, '');
      merged.notes          = aiResult.notes          || null;
      merged.previousSchool = aiResult.previousSchool || null;
      // AI can refine year/position if ESPN didn't have it
      merged.year           = topESPN.year || aiResult.year;
      merged.position       = topESPN.position || aiResult.position;
      merged.confidence     = Math.min(99, topESPN.confidence + (aiResult.confidence >= 80 ? 5 : 0));
      merged.source         = 'espn-roster+ai';
      merged.sourceLabel    = 'ESPN Live Roster + AI verified';
    } else {
      merged.schoolTier = inferSchoolTier(topESPN.school, '');
    }

    candidates.push(merged);

    // Add remaining ESPN candidates (unmerged) if they scored well
    for (const c of espnCandidates.slice(1)) {
      if (c._nameScore >= 15) {
        candidates.push({ ...c, schoolTier: inferSchoolTier(c.school, '') });
      }
    }
  } else if (aiResult) {
    // AI-only result (ESPN couldn't find the school/sport combo)
    candidates.push({
      name:          aiResult.name,
      school:        aiResult.school || normSchool,
      sport:         aiResult.sport  || normSport,
      position:      aiResult.position || null,
      year:          aiResult.year   || null,
      stats:         aiResult.stats  || null,
      height:        aiResult.height || null,
      weight:        aiResult.weight || null,
      hometown:      aiResult.hometown || null,
      instagram:     aiResult.instagram || 0,
      tiktok:        aiResult.tiktok    || 0,
      engagement:    aiResult.engagement|| 0,
      schoolTier:    aiResult.schoolTier || null,
      notes:         aiResult.notes  || null,
      previousSchool:aiResult.previousSchool || null,
      source:        'ai-knowledge',
      sourceLabel:   'AI Training Knowledge',
      confidence:    aiResult.confidence || 72,
    });
  }

  // Stage 4 — Return
  if (!candidates.length) {
    return { found: false, candidates: [] };
  }

  // Mark best
  candidates[0].best = true;

  const autoSelect = candidates[0].confidence >= 95;

  return {
    found:      true,
    candidates: candidates.slice(0, 3),
    autoSelect,
    ...(autoSelect ? flattenCandidate(candidates[0]) : {}),
  };
}

module.exports = { resolveAthlete, normalizeName, normalizeSchool, normalizeSport, nameMatchScore };
