// server/services/university/DataIntegrityLayer.js
// Data Integrity Layer — mandatory wrapper for all University Mode outputs.
//
// RULES (from architecture spec):
//   - Every metric MUST include: source, timestamp, confidence score
//   - Missing data → label "unverified", never silently inferred
//   - Estimated data → explicitly marked estimated:true with explanation
//   - No field rendered without metadata
//
// This is a pure-function module. No DB access. No side effects.
// All university services call wrap() before returning values.

'use strict';

const ALLOWED_MODES  = ['university', 'university_admin', 'admin'];
const FORBIDDEN_DEPS = [
  'NILViewVal', 'OutreachService', 'DealClose', 'PitchGeneration',
  'EmailGeneration', 'brand_match_scores', 'brand_contacts',
  'outreach_logs', 'valuation',
];

// ── assertUniversityMode ──────────────────────────────────────────
function assertUniversityMode(role) {
  if (!ALLOWED_MODES.includes(role)) {
    throw new Error(`[DataIntegrityLayer] Access denied for role: ${role}`);
  }
}

// ── wrap ──────────────────────────────────────────────────────────
// Wraps a single value with required trust metadata.
//
// wrap(value, options)
//   value    — the raw metric value
//   options:
//     source      — string: where the data came from ('athlete.data', 'computed', etc.)
//     confidence  — 0.0–1.0: how reliable this value is
//     estimated   — bool: true if the value was derived, not directly observed
//     estimatedNote — string: required when estimated=true, explains the basis
//     timestamp   — ISO string: when was this data last verified/updated
//     label       — optional display label override
//
// Returns: WrappedValue object
function wrap(value, options = {}) {
  const {
    source       = 'unknown',
    confidence   = 0.5,
    estimated    = false,
    estimatedNote = null,
    timestamp    = null,
    label        = null,
  } = options;

  const missing = value === null || value === undefined || value === '';

  if (missing) {
    return {
      value:     null,
      display:   label || 'Unverified',
      source:    source,
      confidence: 0,
      estimated: false,
      verified:  false,
      timestamp: null,
      missing:   true,
    };
  }

  if (estimated && !estimatedNote) {
    throw new Error(
      `[DataIntegrityLayer] wrap() called with estimated=true but no estimatedNote. ` +
      `Every estimated value must explain its basis. Source: ${source}`
    );
  }

  return {
    value,
    display:       label !== null ? label : String(value),
    source,
    confidence:    Math.min(1, Math.max(0, Number(confidence))),
    estimated,
    estimatedNote: estimated ? estimatedNote : null,
    verified:      !estimated && confidence >= 0.7,
    timestamp,
    missing:       false,
  };
}

// ── wrapObject ────────────────────────────────────────────────────
// Wraps an entire object of named metrics.
// Each key maps to { value, ...wrapOptions }.
//
// Input:  { key: { value, source, confidence, ... } }
// Output: { key: WrappedValue }
function wrapObject(fields) {
  const result = {};
  for (const [key, options] of Object.entries(fields)) {
    const { value, ...rest } = options;
    result[key] = wrap(value, rest);
  }
  return result;
}

// ── freshnessScore ────────────────────────────────────────────────
// Computes a 0–100 data freshness score from a timestamp.
// Returns { score, label, daysOld, stale }
//
// Score bands:
//   100–80  → Fresh       (0–7 days)
//   79–60   → Current     (8–14 days)
//   59–40   → Aging       (15–30 days)
//   39–20   → Stale       (31–60 days)
//   19–0    → Very stale  (>60 days)
//   null ts → Unknown (score 0, label "Date unknown")
function freshnessScore(timestamp) {
  if (!timestamp) {
    return { score: 0, label: 'Date unknown', daysOld: null, stale: true };
  }

  const now     = Date.now();
  const then    = new Date(timestamp).getTime();
  const daysOld = Math.floor((now - then) / (1000 * 60 * 60 * 24));

  let score, label;
  if (daysOld <= 7)       { score = 100; label = 'Fresh'; }
  else if (daysOld <= 14) { score = Math.round(80 - ((daysOld - 7) / 7) * 20); label = 'Current'; }
  else if (daysOld <= 30) { score = Math.round(60 - ((daysOld - 14) / 16) * 20); label = 'Aging'; }
  else if (daysOld <= 60) { score = Math.round(40 - ((daysOld - 30) / 30) * 20); label = 'Stale'; }
  else                    { score = Math.max(0, Math.round(20 - ((daysOld - 60) / 60) * 20)); label = 'Very stale'; }

  return {
    score:   Math.min(100, Math.max(0, score)),
    label,
    daysOld,
    stale:   daysOld > 30,
  };
}

// ── profileCompleteness ───────────────────────────────────────────
// Computes a structured profile completeness score from athlete data.
// Returns { score: 0–100, breakdown: { field: present|missing } }
//
// Weights are documented — no silent assumptions.
const COMPLETENESS_FIELDS = [
  { key: 'name',        weight: 15, label: 'Name' },
  { key: 'sport',       weight: 15, label: 'Sport' },
  { key: 'school',      weight: 15, label: 'School' },
  { key: 'position',    weight: 5,  label: 'Position' },
  { key: 'instagram',   weight: 10, label: 'Instagram' },
  { key: 'tiktok',      weight: 10, label: 'TikTok' },
  { key: 'engagement',  weight: 15, label: 'Engagement rate' },
  { key: 'stats',       weight: 10, label: 'Athletic stats' },
  { key: 'notes',       weight: 5,  label: 'Bio / notes' },
];

function profileCompleteness(athleteData) {
  const d = (athleteData && typeof athleteData === 'object') ? athleteData : {};
  let earned = 0;
  const breakdown = {};

  for (const field of COMPLETENESS_FIELDS) {
    const val      = d[field.key];
    const present  = val !== null && val !== undefined && val !== '' && val !== 0 && val !== '0';
    breakdown[field.key] = {
      label:   field.label,
      present,
      weight:  field.weight,
    };
    if (present) earned += field.weight;
  }

  const score = Math.min(100, earned); // weights sum to 100

  return {
    score,
    breakdown,
    source:    'athlete.data',
    confidence: 1.0, // deterministic from the data itself
  };
}

// ── confidenceFromSocialData ──────────────────────────────────────
// Estimates confidence in social metrics based on what's available.
// Returns 0.0–1.0 with a documented basis.
function confidenceFromSocialData(athleteData) {
  const d = athleteData || {};
  let conf = 0;

  if (parseInt(d.instagram) > 0)  conf += 0.30;
  if (parseInt(d.tiktok) > 0)     conf += 0.25;
  if (parseFloat(d.engagement) > 0) conf += 0.30;

  // Engagement plausibility check — flags values that look fabricated
  const er = parseFloat(d.engagement) || 0;
  if (er > 0 && er <= 25) conf += 0.15; // above 25% ER is implausible for most accounts
  else if (er > 25)        conf -= 0.20; // penalise implausible values

  return { confidence: Math.min(1, Math.max(0, conf)), basis: 'social field presence + ER plausibility check' };
}

module.exports = {
  assertUniversityMode,
  wrap,
  wrapObject,
  freshnessScore,
  profileCompleteness,
  confidenceFromSocialData,
  ALLOWED_MODES,
  FORBIDDEN_DEPS,
};
