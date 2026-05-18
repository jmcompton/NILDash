-- server/migrations/002_university_hierarchy.sql
-- University hierarchy: universities table + user linking.
--
-- SAFETY:
--   All IF NOT EXISTS. Safe to run multiple times.
--   No existing data touched. No foreign key constraints that could
--   break existing rows (university_id is nullable everywhere).
--
-- WHAT THIS ADDS:
--   1. universities table — canonical university registry
--   2. users.university_id — links a university-role account to one university
--
-- WHAT THIS DOES NOT TOUCH:
--   athletes table schema, agent_id, data JSONB, outreach_logs,
--   brand_match_scores, brand_contacts, company_enrichment, deals

-- ── 1. Universities registry ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS universities (
  id           TEXT         PRIMARY KEY,   -- 'univ-samford', slug format
  name         TEXT         NOT NULL UNIQUE, -- 'Samford University'
  short_name   TEXT,                         -- 'Samford'
  conference   TEXT,                         -- 'SoCon', 'SEC', etc.
  location     TEXT,                         -- 'Birmingham, AL'
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS universities_name_idx ON universities (LOWER(name));

-- ── 2. Link users to their university ────────────────────────────
-- Nullable — agent/athlete/admin users have NULL here.
-- Only university and university_admin roles use this field.
ALTER TABLE universities ADD COLUMN IF NOT EXISTS sport_count INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS university_id TEXT REFERENCES universities(id);

-- ── 3. Samford University — initial seed ─────────────────────────
-- Insert only if it doesn't exist yet.
INSERT INTO universities (id, name, short_name, conference, location)
VALUES ('univ-samford', 'Samford University', 'Samford', 'SoCon', 'Birmingham, AL')
ON CONFLICT (id) DO NOTHING;
