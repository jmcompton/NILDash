-- 015_university_market_crm.sql
-- A department's town: who to talk to at every business, and the shared record
-- of who on staff already did.
--
-- UNIVERSITY SIDE ONLY (read 007 first). No agent table is read or written and
-- no university column is added to one. Every row carries university_id; one
-- university's rows are never visible to another (services/campusMarket scopes
-- every query by it).
--
-- THE CRM TRACKS THE MARKET, NOT THE ATHLETES. An agent follows their
-- athletes' deals; a department has several staff working the same thousand
-- businesses in one town for years. What survives staff turnover is: who
-- already talked to this restaurant, when, how, and what came back.
--
-- Runs on every boot, statement by statement. Every statement is IF NOT EXISTS.

-- WHO TO TALK TO, per business. Resolved once (services/campusContacts) from
-- every source we have, then kept. reachable = a named human AND a way to reach
-- them (email, phone or an Instagram DM handle).
CREATE TABLE IF NOT EXISTS university_contacts (
  university_id   TEXT        NOT NULL,
  market_key      TEXT        NOT NULL,
  brand           TEXT        NOT NULL,
  place_id        TEXT,
  contact_name    TEXT,
  contact_title   TEXT,
  email           TEXT,
  email_source    TEXT,
  phone           TEXT,
  instagram       TEXT,
  website         TEXT,
  facebook        TEXT,
  linkedin        TEXT,
  sources         JSONB,
  athlete_history BOOLEAN,
  athlete_history_note TEXT,
  team_fit        JSONB,
  reachable       BOOLEAN     NOT NULL DEFAULT FALSE,
  status          TEXT        NOT NULL DEFAULT 'pending',
  last_error      TEXT,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  cost_usd        NUMERIC     NOT NULL DEFAULT 0,
  resolved_at     TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (university_id, brand)
);
CREATE INDEX IF NOT EXISTS university_contacts_status_idx ON university_contacts (university_id, status);

-- WHERE EACH BUSINESS STANDS with the department. One row per business.
-- stage: not_contacted | contacted | replied | in_talks | deal_signed | declined | do_not_contact
CREATE TABLE IF NOT EXISTS university_crm (
  university_id   TEXT        NOT NULL,
  brand           TEXT        NOT NULL,
  stage           TEXT        NOT NULL DEFAULT 'not_contacted',
  notes           TEXT,
  owner_user_id   TEXT,
  last_touch_at   TIMESTAMPTZ,
  last_touch_by   TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by      TEXT,
  PRIMARY KEY (university_id, brand)
);

-- EVERY TOUCH, by whom, when, how, what was said and what came back. Never
-- edited; the history is the point.
CREATE TABLE IF NOT EXISTS university_touches (
  id              SERIAL      PRIMARY KEY,
  university_id   TEXT        NOT NULL,
  brand           TEXT        NOT NULL,
  user_id         TEXT,
  user_name       TEXT,
  channel         TEXT,
  direction       TEXT        NOT NULL DEFAULT 'out',
  team_id         TEXT,
  athlete_name    TEXT,
  summary         TEXT,
  outcome         TEXT,
  stage_after     TEXT,
  draft_id        TEXT,
  at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS university_touches_brand_idx ON university_touches (university_id, brand, at DESC);

-- DEALS, against a team or one athlete, with value.
CREATE TABLE IF NOT EXISTS university_deals (
  id              SERIAL      PRIMARY KEY,
  university_id   TEXT        NOT NULL,
  brand           TEXT        NOT NULL,
  team_id         TEXT,
  athlete_name    TEXT,
  value_cents     INTEGER,
  description     TEXT,
  signed_on       DATE,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS university_deals_university_idx ON university_deals (university_id);

-- ONE RUN of the deep pool build or contact resolution, with what it cost.
CREATE TABLE IF NOT EXISTS university_market_runs (
  id              SERIAL      PRIMARY KEY,
  university_id   TEXT        NOT NULL,
  kind            TEXT        NOT NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at     TIMESTAMPTZ,
  summary         JSONB
);
