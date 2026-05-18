-- server/migrations/004_ingestion_pipeline.sql
-- Automated Roster Ingestion Pipeline
--
-- SAFETY:
--   All IF NOT EXISTS. Safe to run multiple times.
--   Zero changes to existing tables.
--
-- WHAT THIS ADDS:
--   1. ingestion_events        — every ingest attempt, full audit trail
--   2. athlete_entity_links    — resolution decision per event
--   3. automation_scheduler_log — scheduler tick + per-university sync times

-- ── 1. Ingestion events ────────────────────────────────────────────────────
-- Every piece of data entering the system creates one event.
-- Events are immutable once committed. Status tracks pipeline progress.
CREATE TABLE IF NOT EXISTS ingestion_events (
  id               TEXT         PRIMARY KEY,  -- uuid
  university_id    TEXT,                       -- null if university unresolved
  source_type      TEXT         NOT NULL
                                CHECK (source_type IN (
                                  'bulk_import','api_feed','webhook',
                                  'manual','scheduler','seed'
                                )),
  source_id        TEXT         NOT NULL DEFAULT 'src-unknown',
  raw_payload      JSONB        NOT NULL,      -- unmodified input
  normalized       JSONB,                      -- after normalization pass
  status           TEXT         NOT NULL DEFAULT 'pending'
                                CHECK (status IN (
                                  'pending','resolving','committed',
                                  'partial','duplicate','failed'
                                )),
  ingestion_confidence INTEGER  NOT NULL DEFAULT 50
                                CHECK (ingestion_confidence BETWEEN 0 AND 100),
  content_hash     TEXT,                       -- sha-like dedup key (name+sport+school)
  error_message    TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved_at      TIMESTAMPTZ,
  committed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ie_university_idx ON ingestion_events (university_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ie_status_idx     ON ingestion_events (status);
CREATE INDEX IF NOT EXISTS ie_hash_idx       ON ingestion_events (content_hash) WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS ie_source_idx     ON ingestion_events (source_type, created_at DESC);

-- ── 2. Entity resolution decisions ────────────────────────────────────────
-- Links each ingestion event to the athlete record it resolved to.
-- Preserves full resolution decision for audit/rollback.
CREATE TABLE IF NOT EXISTS athlete_entity_links (
  id                 SERIAL       PRIMARY KEY,
  ingestion_event_id TEXT         NOT NULL REFERENCES ingestion_events(id),
  athlete_id         TEXT,        -- null if new_entity not yet inserted
  match_type         TEXT         NOT NULL
                                  CHECK (match_type IN (
                                    'exact','probable','new_entity','conflict','skipped'
                                  )),
  match_score        NUMERIC(4,3) NOT NULL DEFAULT 0,  -- 0.000–1.000
  conflict_flags     TEXT[]       NOT NULL DEFAULT '{}',
  resolution_reason  TEXT,
  resolved_by        TEXT         NOT NULL DEFAULT 'system',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ael_event_idx   ON athlete_entity_links (ingestion_event_id);
CREATE INDEX IF NOT EXISTS ael_athlete_idx ON athlete_entity_links (athlete_id) WHERE athlete_id IS NOT NULL;

-- ── 3. Automation scheduler log ───────────────────────────────────────────
-- Tracks scheduler ticks and per-university sync timing.
-- Scheduler reads this on startup to resume correctly after restarts.
CREATE TABLE IF NOT EXISTS automation_scheduler_log (
  id                TEXT         PRIMARY KEY,  -- uuid
  university_id     TEXT,        -- null = global tick
  event_type        TEXT         NOT NULL
                                 CHECK (event_type IN (
                                   'tick','light_sync','deep_sync',
                                   'ingestion_queue','error','start','stop'
                                 )),
  universities_processed INTEGER NOT NULL DEFAULT 0,
  events_processed  INTEGER      NOT NULL DEFAULT 0,
  syncs_triggered   INTEGER      NOT NULL DEFAULT 0,
  error_message     TEXT,
  duration_ms       INTEGER,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS asl_university_idx ON automation_scheduler_log (university_id, created_at DESC);
CREATE INDEX IF NOT EXISTS asl_event_idx      ON automation_scheduler_log (event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS asl_time_idx       ON automation_scheduler_log (created_at DESC);

-- Convenience view: last sync time per university (used by scheduler)
CREATE OR REPLACE VIEW university_sync_health AS
SELECT
  u.id                                           AS university_id,
  u.name                                         AS university_name,
  MAX(CASE WHEN asl.event_type IN ('light_sync','deep_sync')
      THEN asl.created_at END)                   AS last_sync_at,
  MAX(CASE WHEN asl.event_type = 'deep_sync'
      THEN asl.created_at END)                   AS last_deep_sync_at,
  MAX(CASE WHEN asl.event_type = 'light_sync'
      THEN asl.created_at END)                   AS last_light_sync_at,
  COUNT(CASE WHEN asl.event_type IN ('light_sync','deep_sync')
        AND asl.created_at > NOW() - INTERVAL '7 days'
        THEN 1 END)                              AS syncs_last_7d
FROM universities u
LEFT JOIN automation_scheduler_log asl ON asl.university_id = u.id
GROUP BY u.id, u.name;
