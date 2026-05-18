// server/services/university/ProgramAggregationService.js
// Program Aggregation Service — University Mode only.
//
// PURPOSE:
//   Aggregates athlete-level data into program-level intelligence.
//   Produces: program health score, readiness distribution, engagement
//   averages, trend direction, data reliability score.
//
// DATA SOURCES (whitelist — enforced):
//   - athletes (read-only via passed array)
//   - ReadinessEngine (pure computation)
//   - DataIntegrityLayer (pure functions)
//   - ComplianceActivityService (for activity signals)
//
// EXPLICITLY FORBIDDEN:
//   - NILViewVal engine
//   - outreach_logs
//   - brand_match_scores, brand_contacts, company_enrichment
//   - Any valuation or monetization computation

'use strict';

const { assertUniversityMode, freshnessScore, wrap } = require('./DataIntegrityLayer');
const { computeReadiness } = require('./ReadinessEngine');
const { FEATURE_UNIVERSITY_MODE, FEATURE_UNIVERSITY_READINESS_ENGINE } = require('../../config/features');

const ALLOWED_MODES  = ['university', 'university_admin', 'admin'];
const FORBIDDEN_DEPS = ['NILViewVal', 'outreach_logs', 'brand_match_scores', 'brand_contacts', 'company_enrichment'];

// ── Health score weights (documented, must sum to 100) ─────────────
const HEALTH_WEIGHTS = {
  readiness:   40, // avg readiness score across program
  engagement:  35, // avg engagement rate (normalized)
  activity:    25, // data completeness + freshness
};
const HEALTH_WEIGHT_SUM = Object.values(HEALTH_WEIGHTS).reduce((a, b) => a + b, 0);
if (HEALTH_WEIGHT_SUM !== 100) throw new Error(`[ProgramAggregationService] Health weights must sum to 100, got ${HEALTH_WEIGHT_SUM}`);

// ── buildProgramOverview ──────────────────────────────────────────
// Primary export. Aggregates all athletes into a ProgramOverview.
//
// athletes:  array of raw DB rows (with data JSONB)
// dealMap:   { athlete_id: dealCount } — from nil_activity_log query
// userRole:  for mode assertion
//
// Returns: ProgramOverview
async function buildProgramOverview(athletes, dealMap = {}, userRole = 'university') {
  assertUniversityMode(userRole);

  if (!athletes || athletes.length === 0) {
    return emptyOverview();
  }

  // ── Per-athlete readiness computation ────────────────────────────
  const athleteResults = athletes.map(athlete => {
    const dealsCount = dealMap[athlete.id] || 0;
    const readiness  = FEATURE_UNIVERSITY_READINESS_ENGINE
      ? computeReadiness(athlete, dealsCount, userRole)
      : fallbackReadiness(athlete, dealsCount);

    const d = extractData(athlete);
    const reach = (parseInt(d.instagram) || 0) + (parseInt(d.tiktok) || 0);
    const er    = parseFloat(d.engagement) || 0;
    const freshness = freshnessScore(athlete.last_updated_at || null);

    return { athlete, d, readiness, reach, er, dealsCount, freshness };
  });

  const total = athleteResults.length;

  // ── Readiness distribution ───────────────────────────────────────
  const distribution = {
    highPerformer:    { count: 0, label: 'High Performer',    minScore: 75 },
    ready:            { count: 0, label: 'Ready',             minScore: 55 },
    developing:       { count: 0, label: 'Developing',        minScore: 35 },
    needsDevelopment: { count: 0, label: 'Needs Development', minScore: 0  },
  };
  let totalReadinessScore = 0;

  athleteResults.forEach(({ readiness }) => {
    totalReadinessScore += readiness.score;
    if      (readiness.score >= 75) distribution.highPerformer.count++;
    else if (readiness.score >= 55) distribution.ready.count++;
    else if (readiness.score >= 35) distribution.developing.count++;
    else                            distribution.needsDevelopment.count++;
  });

  const avgReadiness = Math.round(totalReadinessScore / total);

  // ── Engagement averages ──────────────────────────────────────────
  const athletesWithER = athleteResults.filter(a => a.er > 0);
  const avgEngagement  = athletesWithER.length > 0
    ? parseFloat((athletesWithER.reduce((s, a) => s + a.er, 0) / athletesWithER.length).toFixed(2))
    : 0;
  const totalReach = athleteResults.reduce((s, a) => s + a.reach, 0);

  // ── Sport breakdown ──────────────────────────────────────────────
  const sportBreakdown = {};
  athleteResults.forEach(({ d }) => {
    const sport = d.sport || 'Unknown';
    sportBreakdown[sport] = (sportBreakdown[sport] || 0) + 1;
  });

  // ── Data freshness + reliability ─────────────────────────────────
  const freshAthletes   = athleteResults.filter(a => !a.freshness.stale).length;
  const dataFreshnessPct = Math.round((freshAthletes / total) * 100);

  // Reliability: weighted average of confidence across all athlete readiness scores
  const avgConfidence = parseFloat(
    (athleteResults.reduce((s, a) => s + (a.readiness.overallConfidence || 0.5), 0) / total).toFixed(3)
  );

  // Data reliability score (0–100): combines freshness + avg confidence
  const dataReliabilityScore = Math.round((dataFreshnessPct * 0.5) + (avgConfidence * 100 * 0.5));

  // ── Activity score (for health) ──────────────────────────────────
  // Measures completeness + freshness across the program
  const totalCompletenessScore = athleteResults.reduce((s, { readiness }) => {
    return s + (readiness.breakdown?.profileCompletion?.raw || 0);
  }, 0);
  const avgCompletenessRaw = Math.round(totalCompletenessScore / total); // 0–100
  const activityDimension  = Math.round((avgCompletenessRaw * 0.6) + (dataFreshnessPct * 0.4));

  // ── Program Health Score ─────────────────────────────────────────
  // Documented formula — no opaque calculation
  // Component 1: avg readiness (already 0–100)
  // Component 2: avg engagement, normalized to 0–100
  //   Benchmark: 3% ER ≈ 60/100, 6%+ ≈ 100/100, 0% ≈ 0/100
  const engagementNormalized = Math.min(100, Math.round((avgEngagement / 6) * 100));
  const programHealthScore   = Math.min(100, Math.round(
    (avgReadiness        * HEALTH_WEIGHTS.readiness   / 100) +
    (engagementNormalized * HEALTH_WEIGHTS.engagement  / 100) +
    (activityDimension   * HEALTH_WEIGHTS.activity    / 100)
  ));

  const programHealthLabel =
    programHealthScore >= 75 ? 'Strong'     :
    programHealthScore >= 55 ? 'Healthy'    :
    programHealthScore >= 35 ? 'Developing' : 'Needs attention';

  // ── Trend analysis ───────────────────────────────────────────────
  // Without historical snapshots in the DB, we can only derive a
  // proxy direction from data freshness. This is explicitly marked
  // as estimated — not presented as measured trend data.
  const trendAnalysis = deriveTrendProxy(athleteResults);

  return {
    totalAthletes:    total,
    avgReadinessScore: wrap(avgReadiness, {
      source:     'ReadinessEngine aggregate',
      confidence: avgConfidence,
      timestamp:  new Date().toISOString(),
    }),
    avgEngagementRate: wrap(avgEngagement, {
      source:     'athlete.data.engagement aggregate',
      confidence: avgConfidence,
      timestamp:  new Date().toISOString(),
    }),
    totalSocialReach: wrap(totalReach, {
      source:     'athlete.data.instagram + athlete.data.tiktok aggregate',
      confidence: avgConfidence,
      estimated:  true,
      estimatedNote: 'Sum of self-reported follower counts — not independently verified',
      timestamp:  new Date().toISOString(),
    }),
    readinessDistribution: distribution,
    sportBreakdown,
    programHealth: {
      score:      programHealthScore,
      label:      programHealthLabel,
      breakdown:  {
        readiness:   { score: Math.round(avgReadiness * HEALTH_WEIGHTS.readiness / 100),   weight: HEALTH_WEIGHTS.readiness,  basis: 'avg readiness score' },
        engagement:  { score: Math.round(engagementNormalized * HEALTH_WEIGHTS.engagement / 100), weight: HEALTH_WEIGHTS.engagement, basis: 'avg ER normalized to 6% benchmark' },
        activity:    { score: Math.round(activityDimension * HEALTH_WEIGHTS.activity / 100), weight: HEALTH_WEIGHTS.activity,  basis: 'profile completeness + data freshness' },
      },
      formula: 'weighted_avg(readiness×40, engagement×35, activity×25)',
    },
    trendAnalysis,
    dataReliability: {
      score:        dataReliabilityScore,
      freshnessPct: dataFreshnessPct,
      avgConfidence,
      freshAthletes,
      staleAthletes: total - freshAthletes,
      basis:        'freshness_50pct + confidence_50pct',
    },
    generatedAt:  new Date().toISOString(),
    dataSource:   'athletes table via ReadinessEngine + DataIntegrityLayer',
  };
}

// ── deriveTrendProxy ─────────────────────────────────────────────
// Without historical data, derive a directional proxy from
// current state signals. Always marked estimated.
function deriveTrendProxy(athleteResults) {
  const recentlyUpdated = athleteResults.filter(a => {
    if (!a.athlete.last_updated_at) return false;
    const daysOld = (Date.now() - new Date(a.athlete.last_updated_at).getTime()) / (1000 * 60 * 60 * 24);
    return daysOld <= 30;
  }).length;

  const freshnessPct = athleteResults.length > 0
    ? recentlyUpdated / athleteResults.length
    : 0;

  const direction = freshnessPct > 0.6 ? 'up' : freshnessPct > 0.3 ? 'stable' : 'unknown';

  return {
    direction,
    estimated:    true,
    estimatedNote: 'Trend direction derived from data freshness proxy — historical snapshots not yet available',
    growthRate30d: null, // requires historical snapshots — not estimated silently
    growthRate90d: null,
    dataAvailable: false,
  };
}

// ── emptyOverview ────────────────────────────────────────────────
function emptyOverview() {
  return {
    totalAthletes: 0,
    avgReadinessScore: wrap(null, { source: 'no athletes', confidence: 0 }),
    avgEngagementRate: wrap(null, { source: 'no athletes', confidence: 0 }),
    totalSocialReach:  wrap(null, { source: 'no athletes', confidence: 0, estimated: true, estimatedNote: 'No athletes in program' }),
    readinessDistribution: {
      highPerformer: { count: 0 }, ready: { count: 0 },
      developing: { count: 0 }, needsDevelopment: { count: 0 },
    },
    sportBreakdown:  {},
    programHealth:   { score: 0, label: 'No data', breakdown: {} },
    trendAnalysis:   { direction: 'unknown', estimated: true, estimatedNote: 'No athletes in program', growthRate30d: null, growthRate90d: null, dataAvailable: false },
    dataReliability: { score: 0, freshnessPct: 0, avgConfidence: 0 },
    generatedAt:     new Date().toISOString(),
    dataSource:      'athletes table',
  };
}

// ── fallbackReadiness ─────────────────────────────────────────────
// Lightweight fallback if ReadinessEngine feature flag is off.
// Less detailed but structurally compatible.
function fallbackReadiness(athlete, dealsCount) {
  const d = extractData(athlete);
  let score = 0;
  const reach = (parseInt(d.instagram) || 0) + (parseInt(d.tiktok) || 0);
  const er    = parseFloat(d.engagement) || 0;
  if (d.name && d.sport && d.school) score += 20;
  if (reach >= 5000)  score += 20;
  if (er >= 2.5)      score += 20;
  if (dealsCount >= 1) score += 15;
  if (d.stats)         score += 10;
  score = Math.min(100, score);
  const label = score >= 75 ? 'High Performer' : score >= 55 ? 'Ready' : score >= 35 ? 'Developing' : 'Needs Development';
  return { score, label, overallConfidence: 0.4, breakdown: { profileCompletion: { raw: 0 } } };
}

function extractData(row) {
  if (row && row.data && typeof row.data === 'object') return { ...row.data, id: row.id };
  return row || {};
}

module.exports = { buildProgramOverview };
