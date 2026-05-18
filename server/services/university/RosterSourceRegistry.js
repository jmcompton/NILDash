// server/services/university/RosterSourceRegistry.js
// Static source catalog — no DB dependency at load time.
// Trust weights determine how much a source's state assertion counts
// during weighted reconciliation.
//
// FORBIDDEN_DEPS: outreach_logs, brand_match_scores, brand_contacts,
//                 company_enrichment, deals, valuation, pricing

'use strict';

// ── Canonical source definitions ──────────────────────────────────────────
const SOURCES = Object.freeze({
  'src-internal': {
    id:          'src-internal',
    name:        'Internal Database',
    type:        'internal',
    trustWeight: 90,
    description: 'Data manually entered or confirmed by an admin or university staff member.',
  },
  'src-manual': {
    id:          'src-manual',
    name:        'Manual Entry',
    type:        'manual',
    trustWeight: 85,
    description: 'Individually confirmed athlete record.',
  },
  'src-import': {
    id:          'src-import',
    name:        'Bulk Import (Reviewed)',
    type:        'import',
    trustWeight: 75,
    description: 'Bulk import that passed the review step before ingestion.',
  },
  'src-import-raw': {
    id:          'src-import-raw',
    name:        'Bulk Import (Raw)',
    type:        'import',
    trustWeight: 50,
    description: 'Bulk import ingested without manual review.',
  },
  'src-external': {
    id:          'src-external',
    name:        'External Enrichment',
    type:        'external',
    trustWeight: 40,
    description: 'Data from an external source. Never the sole basis for state.',
  },
  'src-unknown': {
    id:          'src-unknown',
    name:        'Unknown Source',
    type:        'unknown',
    trustWeight: 10,
    description: 'Origin could not be determined.',
  },
});

// ── Source for a given athlete based on how it was created ────────────────
// Called by sync engine to determine trust weight for an athlete's data.
function resolveSourceForAthlete(athleteData) {
  if (!athleteData) return SOURCES['src-unknown'];

  // Reviewed bulk import: presence of completeness markers
  const hasFullProfile = !!(
    athleteData.name &&
    athleteData.sport &&
    athleteData.school &&
    (athleteData.position || athleteData.stats)
  );

  // Check if university_id is stamped (means it came through our import pipeline)
  const hasUniversityId = !!athleteData.university_id;

  if (hasUniversityId && hasFullProfile) return SOURCES['src-import'];
  if (hasUniversityId)                   return SOURCES['src-import-raw'];
  if (hasFullProfile)                    return SOURCES['src-internal'];
  return SOURCES['src-unknown'];
}

function getSource(sourceId) {
  return SOURCES[sourceId] || SOURCES['src-unknown'];
}

function getAllSources() {
  return Object.values(SOURCES);
}

// ── Profile completeness score (0–100) ────────────────────────────────────
// Used as a data quality input to confidence calculation.
// Mirrors DataIntegrityLayer.profileCompleteness but decoupled.
const COMPLETENESS_WEIGHTS = {
  name:       20,
  sport:      20,
  school:     15,
  position:   15,
  instagram:  10,
  tiktok:      5,
  engagement:  5,
  stats:       5,
  notes:       5,
};
// sum = 100

function profileCompleteness(athleteData) {
  if (!athleteData || typeof athleteData !== 'object') return 0;
  let score = 0;
  for (const [field, weight] of Object.entries(COMPLETENESS_WEIGHTS)) {
    const val = athleteData[field];
    const present = val !== undefined && val !== null && val !== '' && val !== 0;
    if (present) score += weight;
  }
  return Math.min(100, score);
}

module.exports = {
  SOURCES,
  resolveSourceForAthlete,
  getSource,
  getAllSources,
  profileCompleteness,
  COMPLETENESS_WEIGHTS,
};
