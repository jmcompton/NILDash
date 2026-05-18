// server/services/university/ReadinessEngine.js
// NIL Readiness Engine — server-side computation for University Mode.
//
// PURPOSE:
//   Computes a structured, explainable NIL readiness score (0–100)
//   for each athlete. Every dimension is documented, sourced, and
//   includes a per-dimension confidence score.
//
// THIS IS NOT A VALUATION ENGINE.
//   No pricing. No dollar amounts. No brand negotiation signals.
//   Output is used for athlete development + compliance visibility only.
//
// REPLACES: client-side calcNilReadiness() and getDevelopmentRecs()
//           (those functions remain in the frontend temporarily for
//            backward compatibility, but this is the source of truth)

'use strict';

const {
  assertUniversityMode,
  wrap,
  freshnessScore,
  profileCompleteness,
  confidenceFromSocialData,
  FORBIDDEN_DEPS,
} = require('./DataIntegrityLayer');

const ALLOWED_MODES = ['university', 'university_admin', 'admin'];

// ── Score thresholds (documented, not hardcoded silently) ─────────
const THRESHOLDS = {
  HIGH_PERFORMER: 75,
  READY:          55,
  DEVELOPING:     35,
  // below 35 → Needs Development
};

// ── Dimension weights (must sum to 100) ──────────────────────────
const WEIGHTS = {
  profileCompletion: 25, // Is the athlete's data usable?
  socialPresence:    25, // Do they have any audience?
  engagementQuality: 25, // Is that audience active?
  nilActivity:       15, // Have they done NIL work?
  schoolTier:        10, // Institutional context
};
// Verify weights sum to 100 at load time
const WEIGHT_SUM = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
if (WEIGHT_SUM !== 100) throw new Error(`[ReadinessEngine] Weights must sum to 100, got ${WEIGHT_SUM}`);

// ── computeReadiness ─────────────────────────────────────────────
// Primary export. Computes full readiness object for one athlete.
//
// athleteRow: raw DB row (with data JSONB or flat fields)
// dealsCount: integer — how many NIL deals/activities recorded
// userRole:   for mode assertion
//
// Returns: ReadinessResult
function computeReadiness(athleteRow, dealsCount = 0, userRole = 'university') {
  assertUniversityMode(userRole);

  const d = extractData(athleteRow);
  const now = new Date().toISOString();

  // ── Dimension 1: Profile Completion (0–25) ──────────────────────
  const completeness = profileCompleteness(d);
  const dim_profile = {
    score:       Math.round((completeness.score / 100) * WEIGHTS.profileCompletion),
    maxScore:    WEIGHTS.profileCompletion,
    raw:         completeness.score,
    confidence:  completeness.confidence,
    source:      completeness.source,
    note:        completeness.score >= 80
      ? 'Profile well-documented'
      : completeness.score >= 50
      ? 'Profile partially complete — missing fields reduce visibility'
      : 'Profile significantly incomplete — brands cannot evaluate this athlete',
  };

  // ── Dimension 2: Social Presence (0–25) ────────────────────────
  const ig        = parseInt(d.instagram) || 0;
  const tt        = parseInt(d.tiktok)    || 0;
  const reach     = ig + tt;
  const socialConf = confidenceFromSocialData(d);

  let presenceScore;
  if      (reach >= 100000) presenceScore = 25;
  else if (reach >= 50000)  presenceScore = 20;
  else if (reach >= 20000)  presenceScore = 15;
  else if (reach >= 5000)   presenceScore = 10;
  else if (reach >= 1000)   presenceScore = 5;
  else                      presenceScore = 0;

  const dim_social = {
    score:      presenceScore,
    maxScore:   WEIGHTS.socialPresence,
    raw:        reach,
    confidence: socialConf.confidence,
    source:     'athlete.data.instagram + athlete.data.tiktok',
    note:       reach === 0
      ? 'No social presence recorded — a social account is the starting point for NIL activity'
      : reach < 5000
      ? 'Early-stage audience — consistent posting is the clearest growth path'
      : reach < 20000
      ? 'Growing audience — engagement quality matters more than size at this tier'
      : 'Established audience for NIL consideration',
  };

  // ── Dimension 3: Engagement Quality (0–25) ─────────────────────
  const er = parseFloat(d.engagement) || 0;
  // ER plausibility: above 25% is implausible for most public accounts
  const erConfidence = er === 0 ? 0 : er <= 25 ? 0.85 : 0.30;

  let engScore;
  if      (er >= 6)   engScore = 25;
  else if (er >= 4)   engScore = 20;
  else if (er >= 2.5) engScore = 15;
  else if (er >= 1.5) engScore = 10;
  else if (er > 0)    engScore = 5;
  else                engScore = 0;

  const dim_engagement = {
    score:      engScore,
    maxScore:   WEIGHTS.engagementQuality,
    raw:        er,
    confidence: erConfidence,
    source:     'athlete.data.engagement',
    note:       er === 0
      ? 'No engagement rate recorded'
      : er < 1.5
      ? 'Below average engagement — audience growth without engagement rarely translates to NIL opportunity'
      : er < 2.5
      ? 'Average engagement — content quality and consistency can move this metric'
      : er < 6
      ? 'Above average engagement — strong foundation for brand partnership content'
      : er <= 25
      ? 'High engagement rate — audience is actively responsive'
      : 'Engagement rate appears implausible — verify data source',
  };

  // ── Dimension 4: NIL Activity (0–15) ───────────────────────────
  const deals = Math.max(0, parseInt(dealsCount) || 0);
  let activityScore;
  if      (deals >= 5) activityScore = 15;
  else if (deals >= 3) activityScore = 12;
  else if (deals >= 1) activityScore = 8;
  else                 activityScore = 0;

  const dim_activity = {
    score:      activityScore,
    maxScore:   WEIGHTS.nilActivity,
    raw:        deals,
    confidence: 0.9, // deal count comes from our own system
    source:     'nil_activity_log',
    note:       deals === 0
      ? 'No NIL activity recorded in system'
      : deals < 3
      ? 'Initial NIL engagement — compliance review recommended before expanding'
      : 'Active NIL participant — ensure all agreements are disclosed per NCAA guidelines',
  };

  // ── Dimension 5: School Tier (0–10) ────────────────────────────
  const tier = (d.schoolTier || '').toLowerCase();
  let tierScore, tierNote;

  if      (tier.match(/p[45]/) && tier.match(/top/)) { tierScore = 10; tierNote = 'Power 4 top program'; }
  else if (tier.match(/p[45]/))                       { tierScore = 7;  tierNote = 'Power 4 program'; }
  else if (tier.match(/g5/))                          { tierScore = 5;  tierNote = 'Group of 5 program'; }
  else if (tier.match(/d1/))                          { tierScore = 4;  tierNote = 'Division I program'; }
  else if (tier.match(/d2/))                          { tierScore = 3;  tierNote = 'Division II program'; }
  else if (tier.match(/d3/))                          { tierScore = 2;  tierNote = 'Division III program'; }
  else                                                { tierScore = 3;  tierNote = 'School tier not specified'; }

  const dim_schoolTier = {
    score:      tierScore,
    maxScore:   WEIGHTS.schoolTier,
    raw:        d.schoolTier || null,
    confidence: d.schoolTier ? 0.9 : 0.3,
    source:     'athlete.data.schoolTier',
    note:       tierNote,
  };

  // ── Total score ─────────────────────────────────────────────────
  const totalScore = Math.min(100,
    dim_profile.score +
    dim_social.score +
    dim_engagement.score +
    dim_activity.score +
    dim_schoolTier.score
  );

  // ── Label ───────────────────────────────────────────────────────
  let label, labelColor;
  if      (totalScore >= THRESHOLDS.HIGH_PERFORMER) { label = 'High Performer'; labelColor = '#84CC16'; }
  else if (totalScore >= THRESHOLDS.READY)          { label = 'Ready';          labelColor = '#00D4FF'; }
  else if (totalScore >= THRESHOLDS.DEVELOPING)     { label = 'Developing';     labelColor = '#FFB800'; }
  else                                              { label = 'Needs Development'; labelColor = 'rgba(240,244,255,0.45)'; }

  // ── Overall confidence ──────────────────────────────────────────
  const dimConfidences = [
    dim_profile.confidence,
    dim_social.confidence,
    dim_engagement.confidence,
    dim_activity.confidence,
    dim_schoolTier.confidence,
  ];
  const overallConfidence = dimConfidences.reduce((a, b) => a + b, 0) / dimConfidences.length;

  // ── Data freshness ──────────────────────────────────────────────
  const freshness = freshnessScore(athleteRow.last_updated_at || null);

  return {
    score:      totalScore,
    label,
    labelColor,
    breakdown: {
      profileCompletion: dim_profile,
      socialPresence:    dim_social,
      engagementQuality: dim_engagement,
      nilActivity:       dim_activity,
      schoolTier:        dim_schoolTier,
    },
    weights:          WEIGHTS,
    thresholds:       THRESHOLDS,
    overallConfidence: parseFloat(overallConfidence.toFixed(3)),
    dataFreshness:    freshness,
    computedAt:       now,
    // no monetization fields — no low/mid/high rates, no valuation
  };
}

// ── getDevelopmentRecommendations ─────────────────────────────────
// Generates structured, actionable development guidance.
// NO pricing language. NO brand targeting. NO sales framing.
// Output is for athlete development + compliance education only.
function getDevelopmentRecommendations(athleteRow, readinessResult, userRole = 'university') {
  assertUniversityMode(userRole);

  const d   = extractData(athleteRow);
  const bd  = readinessResult.breakdown;
  const recs = [];

  // Profile
  if (bd.profileCompletion.raw < 50) {
    recs.push({
      priority: 'high',
      category: 'Profile',
      action:   'Complete the athlete profile — sport, school, position, and bio are required for any institutional or compliance review.',
      dimension: 'profileCompletion',
    });
  } else if (bd.profileCompletion.raw < 80) {
    recs.push({
      priority: 'medium',
      category: 'Profile',
      action:   'Add missing profile fields (stats, bio, position). Incomplete profiles limit visibility in program analytics.',
      dimension: 'profileCompletion',
    });
  }

  // Social presence
  if (bd.socialPresence.raw === 0) {
    recs.push({
      priority: 'high',
      category: 'Social Presence',
      action:   'Establish a social media presence on Instagram or TikTok. A consistent, authentic account is the starting point for any NIL pathway.',
      dimension: 'socialPresence',
    });
  } else if (bd.socialPresence.raw < 5000) {
    recs.push({
      priority: 'medium',
      category: 'Social Presence',
      action:   'Grow audience through consistent posting — game day content, practice clips, and campus life outperform highlight reels for follower growth.',
      dimension: 'socialPresence',
    });
  }

  // Engagement quality
  if (bd.engagementQuality.raw === 0 && bd.socialPresence.raw > 0) {
    recs.push({
      priority: 'high',
      category: 'Engagement',
      action:   'Engagement rate is missing. Add the current engagement rate to get an accurate readiness assessment.',
      dimension: 'engagementQuality',
    });
  } else if (bd.engagementQuality.raw > 0 && bd.engagementQuality.raw < 2) {
    recs.push({
      priority: 'medium',
      category: 'Engagement',
      action:   'Engagement rate is below benchmark. Posting more conversational content and responding to comments typically improves this metric.',
      dimension: 'engagementQuality',
    });
  } else if (bd.engagementQuality.raw > 25) {
    recs.push({
      priority: 'low',
      category: 'Engagement',
      action:   'Engagement rate appears unusually high — verify the data source. Implausible rates reduce the reliability of the readiness score.',
      dimension: 'engagementQuality',
    });
  }

  // NIL Activity + Compliance
  if (bd.nilActivity.raw === 0) {
    recs.push({
      priority: 'low',
      category: 'Compliance',
      action:   'No NIL activity recorded. Before any first agreement, ensure the athlete reviews NCAA disclosure requirements and school-specific NIL policies.',
      dimension: 'nilActivity',
    });
  } else if (bd.nilActivity.raw >= 1) {
    recs.push({
      priority: 'medium',
      category: 'Compliance',
      action:   'NIL activity is present. Confirm all agreements include FTC disclosure language and that institutional notification requirements (72-hour rule) have been met.',
      dimension: 'nilActivity',
    });
  }

  // Stats
  if (!d.stats) {
    recs.push({
      priority: 'low',
      category: 'Profile',
      action:   'Add athletic stats. Performance data is often the first thing reviewed when evaluating a potential partner.',
      dimension: 'profileCompletion',
    });
  }

  // Data freshness warning
  if (readinessResult.dataFreshness.stale) {
    recs.push({
      priority: 'low',
      category: 'Data Quality',
      action:   `Profile data is ${readinessResult.dataFreshness.daysOld} days old. Update social metrics and stats to keep the readiness score accurate.`,
      dimension: 'dataFreshness',
    });
  }

  // Sort: high → medium → low, cap at 5
  const priorityOrder = { high: 0, medium: 1, low: 2 };
  return recs
    .sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority])
    .slice(0, 5);
}

// ── extractData ───────────────────────────────────────────────────
// Unwraps athlete JSONB — handles both flat and nested formats.
function extractData(row) {
  if (row && row.data && typeof row.data === 'object') {
    return { ...row.data, id: row.id };
  }
  return row || {};
}

module.exports = { computeReadiness, getDevelopmentRecommendations, WEIGHTS, THRESHOLDS };
