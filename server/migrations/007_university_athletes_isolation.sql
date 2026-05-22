-- 007_university_athletes_isolation.sql
-- Creates the university_athletes table to fully isolate university-imported
-- athletes from the agent-side athletes table.
--
-- BEFORE this migration: university imports wrote directly into the shared
-- athletes table (with a university_id JSONB field), causing university
-- athletes to bleed into agent rosters and overwrite agent-side data.
--
-- AFTER this migration: all university import paths write ONLY to
-- university_athletes. The main athletes table is AGENT SIDE ONLY.

CREATE TABLE IF NOT EXISTS university_athletes (
  id            TEXT        PRIMARY KEY,
  university_id TEXT        NOT NULL,
  first_name    TEXT,
  last_name     TEXT,
  name          TEXT,
  sport         TEXT,
  position      TEXT,
  year          TEXT,
  jersey_number TEXT,
  email         TEXT,
  source        TEXT        NOT NULL DEFAULT 'manual',
  data          JSONB       NOT NULL DEFAULT '{}',
  created_at    TIMESTAMP   NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMP   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS univ_athletes_university_id_idx ON university_athletes(university_id);
CREATE INDEX IF NOT EXISTS univ_athletes_sport_idx         ON university_athletes(sport);
CREATE INDEX IF NOT EXISTS univ_athletes_email_idx         ON university_athletes(email);
CREATE INDEX IF NOT EXISTS univ_athletes_name_idx          ON university_athletes(name);

-- Migrate any previously university-imported athletes from the shared table.
-- Identifies them by the presence of university_id in their JSONB data column.
-- This is a best-effort backfill; new imports never touch athletes again.
INSERT INTO university_athletes (id, university_id, name, sport, position, year, jersey_number, email, source, data, created_at, updated_at)
SELECT
  id,
  data->>'university_id'   AS university_id,
  data->>'name'            AS name,
  data->>'sport'           AS sport,
  data->>'position'        AS position,
  data->>'year'            AS year,
  data->>'number'          AS jersey_number,
  data->>'email'           AS email,
  COALESCE(data->>'source', 'manual') AS source,
  data,
  created_at,
  updated_at
FROM athletes
WHERE data->>'university_id' IS NOT NULL
  AND data->>'university_id' != ''
ON CONFLICT (id) DO NOTHING;

-- Remove the migrated records from the agent-side athletes table.
DELETE FROM athletes
WHERE data->>'university_id' IS NOT NULL
  AND data->>'university_id' != '';
