-- 013_university_teams_inventory.sql
-- The university portal's teams and the sponsorship inventory they sell.
--
-- UNIVERSITY SIDE ONLY. Read 007_university_athletes_isolation.sql first:
-- university data once lived in the agent athletes table and bled into agent
-- rosters. These tables are the university's own. No agent table is touched
-- and no university column is added to one.
--
-- Runs on every boot (server/index.js), statement by statement, so every
-- statement is IF NOT EXISTS and safe to repeat.
--
-- market_key uses the agent side's convention exactly: regionKey.marketPoolKey,
-- "city, st" in lower case (Cypress College -> 'cypress, ca'). It is the key
-- market_business_seen is filed under, which is what lets a team's sponsor
-- scan read the same local business pool later.

CREATE TABLE IF NOT EXISTS university_teams (
  id            TEXT        PRIMARY KEY,
  university_id TEXT        NOT NULL,
  name          TEXT        NOT NULL,
  sport         TEXT,
  season        TEXT        CHECK (season IN ('Fall', 'Winter', 'Spring')),
  roster_size   INTEGER,
  venue         TEXT,
  home_dates    INTEGER,
  market_key    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS university_teams_university_id_idx ON university_teams (university_id);

-- team_id NULL means the item is sold department wide, not by one team.
CREATE TABLE IF NOT EXISTS university_inventory (
  id            TEXT        PRIMARY KEY,
  university_id TEXT        NOT NULL,
  team_id       TEXT,
  name          TEXT        NOT NULL,
  price_cents   INTEGER     NOT NULL CHECK (price_cents >= 0),
  status        TEXT        NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'reserved', 'sold')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS university_inventory_university_id_idx ON university_inventory (university_id);
CREATE INDEX IF NOT EXISTS university_inventory_team_id_idx ON university_inventory (team_id);
