-- server/migrations/005_roster_intelligence.sql
-- Roster Intelligence & Auto-Ingestion System
--
-- SAFETY: All IF NOT EXISTS. Zero changes to existing tables.
--
-- WHAT THIS ADDS:
--   1. roster_discovery_jobs   — async job tracking per university+sport request
--   2. roster_discovery_sources — URLs attempted per job with fetch results
--   3. roster_review_queue     — athletes needing human review (confidence 70–94)
--   4. roster_intelligence_log — extraction + scoring audit trail

-- ── 1. Discovery jobs ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roster_discovery_jobs (
  id               TEXT         PRIMARY KEY,
  university_id    TEXT,
  university_name  TEXT         NOT NULL,
  sport            TEXT         NOT NULL,
  triggered_by     TEXT,
  status           TEXT         NOT NULL DEFAULT 'queued'
                                CHECK (status IN (
                                  'queued','discovering','extracting',
                                  'validating','importing','completed','failed'
                                )),
  sources_found    INTEGER      NOT NULL DEFAULT 0,
  sources_fetched  INTEGER      NOT NULL DEFAULT 0,
  athletes_found   INTEGER      NOT NULL DEFAULT 0,
  athletes_imported INTEGER     NOT NULL DEFAULT 0,
  athletes_queued  INTEGER      NOT NULL DEFAULT 0,  -- review queue
  athletes_skipped INTEGER      NOT NULL DEFAULT 0,
  error_message    TEXT,
  progress_message TEXT,
  started_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS rdj_university_idx ON roster_discovery_jobs (university_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rdj_status_idx     ON roster_discovery_jobs (status);

-- ── 2. Sources attempted per job ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roster_discovery_sources (
  id             SERIAL       PRIMARY KEY,
  job_id         TEXT         NOT NULL REFERENCES roster_discovery_jobs(id) ON DELETE CASCADE,
  url            TEXT         NOT NULL,
  source_tier    INTEGER      NOT NULL DEFAULT 2 CHECK (source_tier BETWEEN 1 AND 3),
  source_label   TEXT,        -- 'Official Athletics', 'Conference', 'Profile DB', etc.
  fetch_status   TEXT         NOT NULL DEFAULT 'pending'
                              CHECK (fetch_status IN (
                                'pending','fetched','failed','blocked','empty'
                              )),
  http_status    INTEGER,
  athletes_extracted INTEGER  NOT NULL DEFAULT 0,
  fetch_ms       INTEGER,
  error_message  TEXT,
  fetched_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS rds_job_idx ON roster_discovery_sources (job_id);

-- ── 3. Review queue ───────────────────────────────────────────────────────
-- Athletes with confidence 70–94 land here before CRM import.
CREATE TABLE IF NOT EXISTS roster_review_queue (
  id               SERIAL       PRIMARY KEY,
  job_id           TEXT         NOT NULL REFERENCES roster_discovery_jobs(id),
  university_id    TEXT,
  university_name  TEXT         NOT NULL,
  sport            TEXT         NOT NULL,
  athlete_data     JSONB        NOT NULL,  -- extracted athlete object
  confidence_score INTEGER      NOT NULL CHECK (confidence_score BETWEEN 0 AND 100),
  score_breakdown  JSONB,       -- { officialMatch, positionMatch, yearMatch, ... }
  source_urls      TEXT[]       NOT NULL DEFAULT '{}',
  conflicting_fields TEXT[]     NOT NULL DEFAULT '{}',
  status           TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending','approved','rejected','merged')),
  reviewed_by      TEXT,
  reviewed_at      TIMESTAMPTZ,
  athlete_id       TEXT,        -- populated on approve/merge
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rrq_status_idx     ON roster_review_queue (status, created_at DESC);
CREATE INDEX IF NOT EXISTS rrq_university_idx ON roster_review_queue (university_id, status);
CREATE INDEX IF NOT EXISTS rrq_job_idx        ON roster_review_queue (job_id);

-- ── 4. Intelligence audit log ─────────────────────────────────────────────
-- Every extraction + scoring decision, for debugging and improvement.
CREATE TABLE IF NOT EXISTS roster_intelligence_log (
  id             SERIAL       PRIMARY KEY,
  job_id         TEXT         NOT NULL,
  athlete_name   TEXT,
  sport          TEXT,
  action         TEXT         NOT NULL,  -- 'extracted','scored','auto_imported','queued','skipped'
  confidence     INTEGER,
  details        JSONB,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ril_job_idx  ON roster_intelligence_log (job_id);
CREATE INDEX IF NOT EXISTS ril_time_idx ON roster_intelligence_log (created_at DESC);
