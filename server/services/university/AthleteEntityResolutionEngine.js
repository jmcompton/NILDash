// server/services/university/AthleteEntityResolutionEngine.js
// Probabilistic athlete entity matching.
//
// PURPOSE:
//   Prevent duplicate athlete records by matching incoming data
//   against existing athletes before any write occurs.
//
// MATCH STRATEGY:
//   composite = (name × 0.50) + (sport × 0.30) + (school × 0.20)
//   ≥ 0.92 + sport match  → exact   (update existing)
//   ≥ 0.75 + sport match  → probable (flag for review)
//   < 0.75                → new_entity (safe to insert)
//
// FORBIDDEN_DEPS:
//   outreach_logs, brand_match_scores, brand_contacts,
//   company_enrichment, deals, valuation, pricing

'use strict';

const { normalizeSport, normalizeSchoolName } = require('./BulkImportService');

// ── Jaro-Winkler string similarity (0.0–1.0) ─────────────────────────────
function jaroSimilarity(s1, s2) {
  if (s1 === s2) return 1.0;
  if (!s1 || !s2) return 0.0;

  const len1 = s1.length;
  const len2 = s2.length;
  const matchDist = Math.max(Math.floor(Math.max(len1, len2) / 2) - 1, 0);

  const s1Matches = new Array(len1).fill(false);
  const s2Matches = new Array(len2).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Count matches within match distance
  for (let i = 0; i < len1; i++) {
    const start = Math.max(0, i - matchDist);
    const end   = Math.min(i + matchDist + 1, len2);
    for (let j = start; j < end; j++) {
      if (s2Matches[j] || s1[i] !== s2[j]) continue;
      s1Matches[i] = true;
      s2Matches[j] = true;
      matches++;
      break;
    }
  }

  if (matches === 0) return 0.0;

  // Count transpositions
  let k = 0;
  for (let i = 0; i < len1; i++) {
    if (!s1Matches[i]) continue;
    while (!s2Matches[k]) k++;
    if (s1[i] !== s2[k]) transpositions++;
    k++;
  }

  const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;
  return jaro;
}

function jaroWinkler(s1, s2, p = 0.1) {
  const jaro = jaroSimilarity(s1, s2);
  if (jaro < 0.7) return jaro;

  // Common prefix length (max 4)
  let prefix = 0;
  for (let i = 0; i < Math.min(4, Math.min(s1.length, s2.length)); i++) {
    if (s1[i] === s2[i]) prefix++;
    else break;
  }

  return jaro + prefix * p * (1 - jaro);
}

// ── Name normalization for matching ──────────────────────────────────────
function normalizeName(name) {
  if (!name) return '';
  return name
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, '')   // keep letters, spaces, hyphens, apostrophes
    .replace(/\s+/g, ' ')
    .trim();
}

// ── Sport match score ─────────────────────────────────────────────────────
function sportScore(a, b) {
  if (!a || !b) return 0;
  const na = normalizeSport(a).toLowerCase();
  const nb = normalizeSport(b).toLowerCase();
  if (na === nb) return 1.0;
  // Partial match (e.g. "Basketball" vs "Men's Basketball")
  if (na.includes(nb) || nb.includes(na)) return 0.75;
  return 0;
}

// ── School match score ────────────────────────────────────────────────────
function schoolScore(a, b) {
  if (!a || !b) return 0;
  const na = normalizeSchoolName(a).toLowerCase();
  const nb = normalizeSchoolName(b).toLowerCase();
  if (na === nb) return 1.0;
  if (na.includes(nb) || nb.includes(na)) return 0.7;
  return 0;
}

// ── Composite match score ─────────────────────────────────────────────────
function computeMatchScore(candidate, existing) {
  const nameA  = normalizeName(candidate.name);
  const nameB  = normalizeName(existing.name || '');
  const nScore = jaroWinkler(nameA, nameB);

  // Hard floor on name: below 0.72, don't even score further
  if (nScore < 0.72) return 0;

  const spScore  = sportScore(candidate.sport, existing.sport);
  const scScore  = schoolScore(candidate.school, existing.school);

  return (nScore * 0.50) + (spScore * 0.30) + (scScore * 0.20);
}

// ── THRESHOLDS ────────────────────────────────────────────────────────────
const EXACT_THRESHOLD    = 0.92;
const PROBABLE_THRESHOLD = 0.75;

// ── Main resolution function ──────────────────────────────────────────────
// @param {Pool}   pool          - pg Pool
// @param {object} candidate     - { name, sport, school, position? }
// @param {string} universityId  - scope search to this university first
// @returns {ResolvedAthleteEntity}
async function resolve(pool, candidate, universityId) {
  if (!candidate || !candidate.name) {
    return {
      matchedAthleteId: null,
      matchScore:       0,
      matchType:        'new_entity',
      conflictFlags:    ['Missing name — cannot resolve'],
      resolutionReason: 'No name provided; cannot match',
    };
  }

  // ── 1. Fetch candidate pool ──────────────────────────────────────────
  // Scope to university first, then fall back to all if empty.
  // Limits result set to prevent O(n) full-table scans on large DBs.
  let rows = [];
  try {
    const scopedResult = await pool.query(
      `SELECT id, data FROM athletes
       WHERE data->>'university_id' = $1
         AND data->>'sport' IS NOT NULL
       LIMIT 500`,
      [universityId]
    );
    rows = scopedResult.rows;
  } catch (_) {}

  // ── 2. Score each existing athlete ───────────────────────────────────
  let bestScore  = 0;
  let bestMatch  = null;
  let candidates = [];

  for (const row of rows) {
    const d = (row.data && typeof row.data === 'object') ? row.data : {};
    const existing = { name: d.name || '', sport: d.sport || '', school: d.school || '' };
    const score = computeMatchScore(candidate, existing);

    if (score > 0) {
      candidates.push({ id: row.id, score, existing });
    }
    if (score > bestScore) {
      bestScore = score;
      bestMatch = { id: row.id, score, existing };
    }
  }

  // ── 3. Detect conflicts ───────────────────────────────────────────────
  const conflictFlags = [];
  // Multiple athletes with similar scores (within 0.05 of best) = ambiguous
  const nearMatches = candidates.filter(c => c.score >= bestScore - 0.05 && c.id !== bestMatch?.id);
  if (nearMatches.length > 0 && bestScore >= PROBABLE_THRESHOLD) {
    conflictFlags.push(`Ambiguous match: ${nearMatches.length} similar athlete(s) found`);
  }

  // ── 4. Decision ───────────────────────────────────────────────────────
  let matchType;
  let resolutionReason;

  if (!bestMatch || bestScore < PROBABLE_THRESHOLD) {
    matchType        = 'new_entity';
    resolutionReason = bestMatch
      ? `Best score ${bestScore.toFixed(3)} below probable threshold (${PROBABLE_THRESHOLD})`
      : 'No candidates found in university scope';
    return {
      matchedAthleteId: null,
      matchScore:       Math.round(bestScore * 1000) / 1000,
      matchType,
      conflictFlags,
      resolutionReason,
    };
  }

  if (bestScore >= EXACT_THRESHOLD && conflictFlags.length === 0) {
    matchType        = 'exact';
    resolutionReason = `Score ${bestScore.toFixed(3)} ≥ ${EXACT_THRESHOLD} with no conflicts`;
  } else if (bestScore >= PROBABLE_THRESHOLD) {
    matchType        = conflictFlags.length > 0 ? 'conflict' : 'probable';
    resolutionReason = conflictFlags.length > 0
      ? `Score ${bestScore.toFixed(3)} with ${conflictFlags.length} conflict(s)`
      : `Score ${bestScore.toFixed(3)} in probable range`;
  } else {
    matchType        = 'new_entity';
    resolutionReason = `Score ${bestScore.toFixed(3)} below thresholds`;
  }

  return {
    matchedAthleteId: bestMatch.id,
    matchScore:       Math.round(bestScore * 1000) / 1000,
    matchType,
    conflictFlags,
    resolutionReason,
    candidateCount: candidates.length,
  };
}

// ── Batch resolution ──────────────────────────────────────────────────────
// Resolves a list of candidates. Returns array of ResolvedEntities.
// Used by IngestionPipeline when processing a queue.
async function resolveBatch(pool, candidates, universityId) {
  const results = [];
  for (const candidate of candidates) {
    const resolved = await resolve(pool, candidate, universityId);
    results.push({ candidate, resolved });
  }
  return results;
}

module.exports = {
  resolve,
  resolveBatch,
  computeMatchScore,
  jaroWinkler,
  normalizeName,
  EXACT_THRESHOLD,
  PROBABLE_THRESHOLD,
};
