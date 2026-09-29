-- 014_university_sponsor_scan.sql
-- A team's sponsor scan: the university side's own copies of the four tables
-- the agent scan works through, plus its own pool of local businesses.
--
-- UNIVERSITY SIDE ONLY. Read 007_university_athletes_isolation.sql first. No
-- agent table is read or written by a team scan, and no university column is
-- added to an agent table. The scan engine (services/scout) takes these table
-- names from the subject it is given (Scout.teamSubject), never from a caller.
--
-- ITS OWN POOL. market_business_seen is filed under the same market key, but a
-- row there can exist because an agent typed a business into Add Business for
-- their athlete, so its membership is agent-derived. A team scan discovers its
-- own businesses (Places around the campus address) into
-- university_market_seen and never reads the agent pool.
--
-- Runs on every boot (server/index.js), statement by statement, and from
-- services/teamScan.ensureTables for the admin script. Every statement is
-- IF NOT EXISTS and safe to repeat.

-- Businesses found around a campus. market_key is regionKey.marketPoolKey
-- ('cypress, ca'), the same key convention as university_teams.market_key.
CREATE TABLE IF NOT EXISTS university_market_seen (
  market_key         TEXT        NOT NULL,
  brand              TEXT        NOT NULL,
  place_id           TEXT,
  category           TEXT,
  types              JSONB,
  address            TEXT,
  distance_m         INTEGER,
  rating             NUMERIC,
  user_ratings_total INTEGER,
  chain              BOOLEAN,
  fit                INTEGER,
  fit_reasons        JSONB,
  has_evidence       BOOLEAN,
  evidence           TEXT,
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (market_key, brand)
);

-- What a team's scan has shown, and what became of it. One row per team and
-- business.
CREATE TABLE IF NOT EXISTS university_brand_engagement (
  id             SERIAL      PRIMARY KEY,
  university_id  TEXT        NOT NULL,
  team_id        TEXT        NOT NULL,
  brand_key      TEXT        NOT NULL,
  brand_name     TEXT,
  place_id       TEXT,
  lane           TEXT,
  state          TEXT        NOT NULL DEFAULT 'shown',
  first_shown_at TIMESTAMPTZ,
  last_shown_at  TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (team_id, brand_key)
);

CREATE INDEX IF NOT EXISTS university_brand_engagement_university_id_idx ON university_brand_engagement (university_id);

-- The asks a team's scan has queued. 'queued' holds a slot until someone at the
-- university approves or rejects the draft. Nothing here is ever sent.
CREATE TABLE IF NOT EXISTS university_outreach_queue (
  id             SERIAL      PRIMARY KEY,
  university_id  TEXT        NOT NULL,
  team_id        TEXT        NOT NULL,
  brand_key      TEXT        NOT NULL,
  brand_name     TEXT,
  identity_key   TEXT,
  place_id       TEXT,
  inventory_id   TEXT,
  fit            INTEGER,
  why            TEXT,
  state          TEXT        NOT NULL DEFAULT 'queued',
  expired_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS university_outreach_queue_team_idx ON university_outreach_queue (team_id, state);

-- One row per business researched for a team on a night, so a second run the
-- same night does not research or write for it again.
CREATE TABLE IF NOT EXISTS university_research_claims (
  team_id    TEXT        NOT NULL,
  brand_key  TEXT        NOT NULL,
  night      DATE        NOT NULL,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (team_id, brand_key, night)
);

-- The written ask. It ends here, awaiting approval: sending from the
-- university's mailbox is a later step and nothing reads this table to send.
CREATE TABLE IF NOT EXISTS university_drafts (
  id              TEXT        PRIMARY KEY,
  university_id   TEXT        NOT NULL,
  team_id         TEXT        NOT NULL,
  queue_id        INTEGER,
  brand_key       TEXT        NOT NULL,
  brand_name      TEXT,
  place_id        TEXT,
  inventory_id    TEXT        NOT NULL,
  inventory_name  TEXT        NOT NULL,
  price_cents     INTEGER     NOT NULL,
  subject         TEXT        NOT NULL,
  body            TEXT        NOT NULL,
  model           TEXT,
  status          TEXT        NOT NULL DEFAULT 'awaiting_approval' CHECK (status IN ('awaiting_approval', 'approved', 'rejected')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS university_drafts_team_idx ON university_drafts (team_id, status);
