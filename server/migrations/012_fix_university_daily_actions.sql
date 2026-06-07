-- ── 012: Reconcile university_daily_actions schema drift ─────────────────────
-- Older deployments created university_daily_actions from server/store.js with a
-- conflicting legacy schema (priority TEXT, message, resolved) BEFORE migration
-- 006 ran. Because 006 uses CREATE TABLE IF NOT EXISTS, it never corrected the
-- schema, and its is_dismissed index failed on every boot.
--
-- This table is an ephemeral, recomputed action queue (NILDirectorService
-- DELETEs and re-INSERTs rows on each recalculation), so dropping and recreating
-- it with the canonical schema is safe and loses no durable data.

DROP TABLE IF EXISTS university_daily_actions CASCADE;

CREATE TABLE university_daily_actions (
  id              BIGSERIAL    PRIMARY KEY,
  university_id   TEXT         NOT NULL,

  action_type     TEXT         NOT NULL
                    CHECK (action_type IN (
                      'follow_up', 'deal_review', 'compliance',
                      'renewal', 'outreach', 'approval'
                    )),

  priority        INTEGER      NOT NULL DEFAULT 5
                    CHECK (priority BETWEEN 1 AND 10),

  title           TEXT         NOT NULL,
  detail          TEXT,

  athlete_id      TEXT,
  deal_id         TEXT,

  due_date        DATE,

  is_dismissed    BOOLEAN      NOT NULL DEFAULT false,
  dismissed_by    TEXT,
  dismissed_at    TIMESTAMPTZ,

  auto_generated  BOOLEAN      NOT NULL DEFAULT true,

  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  expires_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS uda_queue_idx       ON university_daily_actions (university_id, is_dismissed, due_date);
CREATE INDEX IF NOT EXISTS uda_athlete_idx     ON university_daily_actions (athlete_id);
CREATE INDEX IF NOT EXISTS uda_action_type_idx ON university_daily_actions (action_type);
