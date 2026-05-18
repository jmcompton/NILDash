-- server/migrations/003_roster_sync_system.sql
-- Continuously Reconciled Roster State Engine
--
-- SAFETY:
--   All IF NOT EXISTS. Safe to run multiple times.
--   Zero changes to existing tables (athletes, universities, users, nil_activity_log).
--   Additive only.
--
-- WHAT THIS ADDS:
--   1. roster_sources         — source registry with trust weights
--   2. athlete_roster_states  — current reconciled state per athlete
--   3. roster_state_history   — immutable state change audit log
--   4. roster_sync_runs       — sync execution log
--   5. roster_snapshots       — program-level version snapshots
--   6. roster_snapshot_athletes — frozen athlete list per snapshot
--
-- WHAT THIS DOES NOT TOUCH:
--   athletes, universities, users, nil_activity_log, outreach_logs,
--   brand_match_scores, brand_contacts, deals

-- ── 1. Source registry ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roster_sources (
  id              TEXT         PRIMARY KEY,
  name            TEXT         NOT NULL,
  source_type     TEXT         NOT NULL CHECK (source_type IN (
                                 'internal','import','manual','external','unknown'
                               )),
  trust_weight    INTEGER      NOT NULL DEFAULT 50
                               CHECK (trust_weight BETWEEN 0 AND 100),
  last_sync_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed built-in sources (idempotent)
INSERT INTO roster_sources (id, name, source_type, trust_weight) VALUES
  ('src-internal',   'Internal Database',       'internal', 90),
  ('src-manual',     'Manual Entry',             'manual',   85),
  ('src-import',     'Bulk Import (Reviewed)',   'import',   75),
  ('src-import-raw', 'Bulk Import (Raw)',        'import',   50),
  ('src-external',   'External Enrichment',      'external', 40),
  ('src-unknown',    'Unknown Source',           'unknown',  10)
ON CONFLICT (id) DO NOTHING;

-- ── 2. Current athlete roster state ──────────────────────────────────────
-- One row per athlete. Upserted on every sync run.
CREATE TABLE IF NOT EXISTS athlete_roster_states (
  id                   SERIAL       PRIMARY KEY,
  athlete_id           TEXT         NOT NULL UNIQUE REFERENCES athletes(id) ON DELETE CASCADE,
  university_id        TEXT         NOT NULL,
  sport                TEXT         NOT NULL,
  status               TEXT         NOT NULL DEFAULT 'unknown'
                                    CHECK (status IN (
                                      'active','probable','uncertain',
                                      'inactive','incoming','unknown'
                                    )),
  confidence_score     INTEGER      NOT NULL DEFAULT 50
                                    CHECK (confidence_score BETWEEN 0 AND 100),
  lifecycle_stage      TEXT         NOT NULL DEFAULT 'unknown'
                                    CHECK (lifecycle_stage IN (
                                      'incoming','active_roster','redshirt',
                                      'transferred','graduated','unknown'
                                    )),
  supporting_sources   TEXT[]       NOT NULL DEFAULT '{}',
  conflicting_sources  TEXT[]       NOT NULL DEFAULT '{}',
  sync_run_id          TEXT,        -- last sync run that produced this state
  last_reconciled_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ars_university_idx ON athlete_roster_states (university_id);
CREATE INDEX IF NOT EXISTS ars_sport_idx      ON athlete_roster_states (university_id, sport);
CREATE INDEX IF NOT EXISTS ars_status_idx     ON athlete_roster_states (university_id, status);

-- ── 3. Immutable state change history ─────────────────────────────────────
-- NEVER deleted. Every state transition appended here.
CREATE TABLE IF NOT EXISTS roster_state_history (
  id                   SERIAL       PRIMARY KEY,
  athlete_id           TEXT         NOT NULL,
  university_id        TEXT         NOT NULL,
  sport                TEXT         NOT NULL,
  status               TEXT         NOT NULL,
  confidence_score     INTEGER      NOT NULL,
  lifecycle_stage      TEXT         NOT NULL,
  supporting_sources   TEXT[]       NOT NULL DEFAULT '{}',
  conflicting_sources  TEXT[]       NOT NULL DEFAULT '{}',
  changed_by           TEXT,        -- sync_run_id or 'manual:userId'
  reason               TEXT,        -- human-readable change reason
  recorded_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rsh_athlete_idx ON roster_state_history (athlete_id);
CREATE INDEX IF NOT EXISTS rsh_univ_idx    ON roster_state_history (university_id, sport);
CREATE INDEX IF NOT EXISTS rsh_time_idx    ON roster_state_history (recorded_at DESC);

-- ── 4. Sync run log ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS roster_sync_runs (
  id                  TEXT         PRIMARY KEY,  -- uuid
  university_id       TEXT         NOT NULL,
  sport               TEXT,                       -- NULL = all sports
  trigger_type        TEXT         NOT NULL
                                   CHECK (trigger_type IN (
                                     'import','manual','scheduled','rollback'
                                   )),
  triggered_by        TEXT,        -- userId or 'system'
  status              TEXT         NOT NULL DEFAULT 'running'
                                   CHECK (status IN ('running','completed','failed')),
  athletes_evaluated  INTEGER      NOT NULL DEFAULT 0,
  state_changes       INTEGER      NOT NULL DEFAULT 0,
  conflicts_detected  INTEGER      NOT NULL DEFAULT 0,
  error_message       TEXT,
  snapshot_id         TEXT,        -- populated on completion
  started_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS rsr_university_idx ON roster_sync_runs (university_id, started_at DESC);
CREATE INDEX IF NOT EXISTS rsr_status_idx     ON roster_sync_runs (status);

-- ── 5. Roster snapshots (version history) ─────────────────────────────────
-- One snapshot per sync run. Append-only — never deleted.
-- is_current=true on the most recent successful snapshot per (university,sport).
CREATE TABLE IF NOT EXISTS roster_snapshots (
  id                    TEXT         PRIMARY KEY,  -- uuid
  university_id         TEXT         NOT NULL,
  sport                 TEXT,                       -- NULL = all sports
  sync_run_id           TEXT         REFERENCES roster_sync_runs(id),
  trigger_type          TEXT         NOT NULL DEFAULT 'manual',
  athlete_count         INTEGER      NOT NULL DEFAULT 0,
  active_count          INTEGER      NOT NULL DEFAULT 0,
  probable_count        INTEGER      NOT NULL DEFAULT 0,
  uncertain_count       INTEGER      NOT NULL DEFAULT 0,
  inactive_count        INTEGER      NOT NULL DEFAULT 0,
  unknown_count         INTEGER      NOT NULL DEFAULT 0,
  avg_confidence        INTEGER      NOT NULL DEFAULT 0,
  completeness_score    INTEGER      NOT NULL DEFAULT 0,  -- 0–100
  changes_from_previous JSONB,       -- {added:[], removed:[], stateChanges:[]}
  is_current            BOOLEAN      NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS rs_university_idx ON roster_snapshots (university_id, created_at DESC);
CREATE INDEX IF NOT EXISTS rs_current_idx    ON roster_snapshots (university_id, is_current) WHERE is_current;

-- ── 6. Athletes frozen in each snapshot ───────────────────────────────────
-- Complete copy of each athlete's state at snapshot time.
-- Enables rollback and historical audit without touching live athlete rows.
CREATE TABLE IF NOT EXISTS roster_snapshot_athletes (
  snapshot_id      TEXT     NOT NULL REFERENCES roster_snapshots(id) ON DELETE CASCADE,
  athlete_id       TEXT     NOT NULL,
  name             TEXT     NOT NULL,
  sport            TEXT     NOT NULL,
  position         TEXT,
  status           TEXT     NOT NULL,
  confidence_score INTEGER  NOT NULL,
  lifecycle_stage  TEXT     NOT NULL,
  PRIMARY KEY (snapshot_id, athlete_id)
);

CREATE INDEX IF NOT EXISTS rsa_snapshot_idx ON roster_snapshot_athletes (snapshot_id);
