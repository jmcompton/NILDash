-- server/migrations/001_university_schema.sql
-- University Mode schema additions.
--
-- SAFETY RULES:
--   All statements are IF NOT EXISTS or ADD COLUMN IF NOT EXISTS.
--   Safe to run multiple times. Zero impact on existing data.
--   Does NOT touch: athletes.data, outreach_logs, brand_match_scores,
--                   brand_contacts, company_enrichment, users.
--
-- Run via: node server/migrations/run.js
-- Or paste directly into Railway PostgreSQL query console.

-- ── 1. Data freshness anchor on athletes ──────────────────────────
-- Without this column, freshness scores are fabricated.
-- Existing rows get NULL → treated as "date unknown" (never "fresh").
ALTER TABLE athletes
  ADD COLUMN IF NOT EXISTS last_updated_at TIMESTAMPTZ DEFAULT NULL;

-- ── 2. NIL Activity Log ───────────────────────────────────────────
-- Compliance event ledger. University mode only.
-- NO monetization data. NO outreach content. NO brand names.
-- Allowed event_types:
--   profile_update    — a profile field was changed
--   readiness_computed — readiness score was calculated
--   data_verified     — a field was verified by system
--   stale_alert       — data freshness threshold crossed
--   system_check      — automated integrity scan
CREATE TABLE IF NOT EXISTS nil_activity_log (
  id            BIGSERIAL       PRIMARY KEY,
  athlete_id    TEXT            NOT NULL,
  user_id       TEXT            NOT NULL,
  event_type    TEXT            NOT NULL
                  CHECK (event_type IN (
                    'profile_update',
                    'readiness_computed',
                    'data_verified',
                    'stale_alert',
                    'system_check'
                  )),
  source_system TEXT            NOT NULL DEFAULT 'nildash',
  confidence    NUMERIC(4,3)    NOT NULL DEFAULT 1.000
                  CHECK (confidence >= 0 AND confidence <= 1),
  metadata      JSONB           NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ     NOT NULL DEFAULT NOW()
);

-- Indexes for the query patterns used by ComplianceActivityService
CREATE INDEX IF NOT EXISTS nil_activity_log_athlete_idx
  ON nil_activity_log (athlete_id);

CREATE INDEX IF NOT EXISTS nil_activity_log_user_idx
  ON nil_activity_log (user_id);

CREATE INDEX IF NOT EXISTS nil_activity_log_created_idx
  ON nil_activity_log (created_at DESC);

CREATE INDEX IF NOT EXISTS nil_activity_log_type_idx
  ON nil_activity_log (athlete_id, event_type);
