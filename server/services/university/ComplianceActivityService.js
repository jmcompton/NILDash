// server/services/university/ComplianceActivityService.js
// Compliance Activity Service — University Mode only.
//
// PURPOSE:
//   Tracks and surfaces verified, system-generated compliance events.
//   Provides a structured view of data quality, profile completeness,
//   and activity consistency for program administrators.
//
// HARD RULES:
//   - NO access to outreach_logs
//   - NO access to brand_match_scores, brand_contacts, company_enrichment
//   - NO private communications or raw email content exposed
//   - NO monetization language in any output field
//   - Events written ONLY by this service — no ad-hoc inserts
//
// ALLOWED DATA SOURCES:
//   - athletes (read-only)
//   - nil_activity_log (read + write)
//   - DataIntegrityLayer (pure functions)
//   - ReadinessEngine (pure computation)

'use strict';

const { assertUniversityMode, freshnessScore, profileCompleteness, wrap } = require('./DataIntegrityLayer');
const { FEATURE_UNIVERSITY_COMPLIANCE } = require('../../config/features');

const ALLOWED_MODES  = ['university', 'university_admin', 'admin'];
const FORBIDDEN_DEPS = ['outreach_logs', 'brand_match_scores', 'brand_contacts', 'company_enrichment'];

// Valid event types — enforced at write time (DB constraint is the second guard)
const VALID_EVENT_TYPES = new Set([
  'profile_update',
  'readiness_computed',
  'data_verified',
  'stale_alert',
  'system_check',
]);

// ── logEvent ──────────────────────────────────────────────────────
// Writes a compliance event to nil_activity_log.
// Returns the inserted row or null if feature is disabled.
async function logEvent(pool, { athleteId, userId, eventType, metadata = {}, confidence = 1.0, sourceSystem = 'nildash' }) {
  if (!FEATURE_UNIVERSITY_COMPLIANCE) return null;

  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new Error(`[ComplianceActivityService] Invalid event_type: "${eventType}". ` +
      `Allowed: ${[...VALID_EVENT_TYPES].join(', ')}`);
  }

  try {
    const result = await pool.query(
      `INSERT INTO nil_activity_log
         (athlete_id, user_id, event_type, source_system, confidence, metadata)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [athleteId, userId, eventType, sourceSystem, confidence, JSON.stringify(metadata)]
    );
    return result.rows[0] || null;
  } catch (err) {
    // Non-fatal — compliance log failure should not block the main request
    console.warn('[ComplianceActivityService] logEvent failed (non-fatal):', err.message);
    return null;
  }
}

// ── getAthleteActivity ────────────────────────────────────────────
// Returns paginated activity log for one athlete.
// Excludes any fields that could expose agent-mode data.
async function getAthleteActivity(pool, { athleteId, userId, limit = 50, offset = 0 }, userRole) {
  assertUniversityMode(userRole);
  if (!FEATURE_UNIVERSITY_COMPLIANCE) return { events: [], total: 0, disabled: true };

  try {
    const [eventsRes, countRes] = await Promise.all([
      pool.query(
        `SELECT id, event_type, source_system, confidence, metadata, created_at
         FROM nil_activity_log
         WHERE athlete_id = $1 AND user_id = $2
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4`,
        [athleteId, userId, limit, offset]
      ),
      pool.query(
        `SELECT COUNT(*) AS total FROM nil_activity_log
         WHERE athlete_id = $1 AND user_id = $2`,
        [athleteId, userId]
      ),
    ]);

    return {
      events: eventsRes.rows.map(sanitizeEvent),
      total:  parseInt(countRes.rows[0].total) || 0,
    };
  } catch (err) {
    console.warn('[ComplianceActivityService] getAthleteActivity failed:', err.message);
    return { events: [], total: 0, error: 'Activity log unavailable' };
  }
}

// ── buildComplianceDashboard ──────────────────────────────────────
// Aggregates compliance signals for all athletes in the program.
// Returns ComplianceDashboard object.
async function buildComplianceDashboard(pool, { athletes, userId }, userRole) {
  assertUniversityMode(userRole);
  if (!FEATURE_UNIVERSITY_COMPLIANCE) {
    return { disabled: true, athletes: [] };
  }

  // Fetch all activity counts per athlete in one query
  let activityMap = {};
  let lastEventMap = {};
  try {
    const actRes = await pool.query(
      `SELECT athlete_id,
              COUNT(*) AS total_events,
              MAX(created_at) AS last_event_at
       FROM nil_activity_log
       WHERE user_id = $1
       GROUP BY athlete_id`,
      [userId]
    );
    actRes.rows.forEach(r => {
      activityMap[r.athlete_id] = parseInt(r.total_events) || 0;
      lastEventMap[r.athlete_id] = r.last_event_at || null;
    });
  } catch (_) {
    // Table may not exist on first deploy — degrade gracefully
  }

  const now = Date.now();
  const athleteProfiles = athletes.map(athlete => {
    const d          = extractData(athlete);
    const completeness  = profileCompleteness(d);
    const freshness     = freshnessScore(athlete.last_updated_at || null);
    const eventCount    = activityMap[athlete.id] || 0;
    const lastEventAt   = lastEventMap[athlete.id] || null;

    // Consistency score: how regularly is data being updated?
    // Based on last_updated_at + event count. Documented basis.
    let consistencyScore;
    if      (eventCount >= 10 && !freshness.stale) consistencyScore = 100;
    else if (eventCount >= 5  && !freshness.stale) consistencyScore = 80;
    else if (eventCount >= 2  && !freshness.stale) consistencyScore = 60;
    else if (eventCount >= 1)                      consistencyScore = 40;
    else                                           consistencyScore = 0;

    // Alerts — explicit, never inferred silently
    const alerts = [];
    if (completeness.score < 50) {
      alerts.push({ severity: 'high', type: 'incomplete_profile', message: 'Profile is less than 50% complete' });
    }
    if (freshness.stale) {
      alerts.push({ severity: 'medium', type: 'stale_data', message: `Data is ${freshness.daysOld} days old — verify social metrics` });
    }
    if (!d.instagram && !d.tiktok) {
      alerts.push({ severity: 'medium', type: 'no_social', message: 'No social accounts on record' });
    }
    if (d.engagement && parseFloat(d.engagement) > 25) {
      alerts.push({ severity: 'low', type: 'implausible_engagement', message: 'Engagement rate may be inaccurate — verify data source' });
    }

    return {
      athleteId:        athlete.id,
      name:             d.name || 'Unknown',
      sport:            d.sport || null,
      school:           d.school || null,
      profileCompleteness: {
        score:     completeness.score,
        breakdown: completeness.breakdown,
        source:    completeness.source,
        confidence: completeness.confidence,
      },
      dataFreshness:    freshness,
      activityConsistency: {
        score:          consistencyScore,
        eventCount,
        lastEventAt,
        basis:          'event frequency + data freshness',
      },
      alerts,
      alertCount:       alerts.length,
      hasHighAlerts:    alerts.some(a => a.severity === 'high'),
    };
  });

  // Program-level aggregates
  const total = athleteProfiles.length;
  const avgCompleteness = total > 0
    ? Math.round(athleteProfiles.reduce((s, a) => s + a.profileCompleteness.score, 0) / total)
    : 0;
  const staleCount      = athleteProfiles.filter(a => a.dataFreshness.stale).length;
  const highAlertCount  = athleteProfiles.filter(a => a.hasHighAlerts).length;
  const missingDataCount = athleteProfiles.filter(a => a.alertCount > 0).length;

  return {
    summary: {
      totalAthletes:       total,
      avgProfileCompleteness: avgCompleteness,
      staleDataCount:      staleCount,
      highAlertCount,
      missingDataCount,
      dataSource:          'athletes table + nil_activity_log',
      generatedAt:         new Date().toISOString(),
    },
    athletes: athleteProfiles,
    disabled: false,
  };
}

// ── sanitizeEvent ─────────────────────────────────────────────────
// Strips any fields that should not leave the service layer.
// Protects against accidental metadata leakage.
function sanitizeEvent(row) {
  return {
    id:           row.id,
    eventType:    row.event_type,
    sourceSystem: row.source_system,
    confidence:   parseFloat(row.confidence),
    metadata:     sanitizeMetadata(row.metadata || {}),
    createdAt:    row.created_at,
  };
}

// Remove any metadata keys that look like agent-mode data
const BLOCKED_METADATA_KEYS = new Set([
  'brand_name', 'outreach_id', 'deal_value', 'email_body',
  'negotiation', 'valuation', 'price', 'rate',
]);

function sanitizeMetadata(meta) {
  const clean = {};
  for (const [k, v] of Object.entries(meta)) {
    if (!BLOCKED_METADATA_KEYS.has(k.toLowerCase())) {
      clean[k] = v;
    }
  }
  return clean;
}

function extractData(row) {
  if (row && row.data && typeof row.data === 'object') {
    return { ...row.data, id: row.id };
  }
  return row || {};
}

module.exports = {
  logEvent,
  getAthleteActivity,
  buildComplianceDashboard,
  VALID_EVENT_TYPES,
};
