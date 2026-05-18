// server/config/features.js
// Central feature flag registry for NILDash.
//
// Rules:
//   - All flags default to false (safe off)
//   - University flags have no effect on Agent Mode
//   - Agent flags have no effect on University Mode
//   - Never gate existing production behavior behind a flag without a fallback

'use strict';

const features = {
  // ── University Mode ──────────────────────────────────────────────
  // Top-level gate. If false, all /api/university/* routes return 503.
  FEATURE_UNIVERSITY_MODE: true,

  // Enables server-side ReadinessEngine (replaces client-side calcNilReadiness).
  // When false, /api/university/dashboard falls back to lightweight inline scoring.
  FEATURE_UNIVERSITY_READINESS_ENGINE: true,

  // Enables ComplianceActivityService and nil_activity_log writes.
  // Safe to disable independently if the table hasn't been created yet.
  FEATURE_UNIVERSITY_COMPLIANCE: true,

  // Enables DataIntegrityLayer wrapping on all university API responses.
  // When false, raw values are returned without trust metadata.
  FEATURE_UNIVERSITY_DATA_INTEGRITY: true,

  // ── Agent Mode ───────────────────────────────────────────────────
  // Mirrors existing flag from ai.js — single source of truth here.
  // ai.js will import from here in Step 7.
  FEATURE_EMAIL_V2: true,
};

module.exports = features;
