-- 020_university_team_nil_rate.sql
-- A team's NIL deal rate, set by the department on My Teams. The nightly pitch
-- (services/teamWriter) quotes it exactly; without one the pitch names no price
-- and says the office will send options. The school sets the price, never NILDash.
-- University side only; safe to repeat.
ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS nil_rate_cents INTEGER;
ALTER TABLE university_teams ADD COLUMN IF NOT EXISTS nil_rate_what TEXT;
