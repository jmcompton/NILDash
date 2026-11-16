-- 021_university_bookings.sql
-- The public booking page (services/universityBook): what a business booked
-- from a school's link. University side only; safe to repeat.
CREATE TABLE IF NOT EXISTS university_bookings (
  id            SERIAL      PRIMARY KEY,
  university_id TEXT        NOT NULL,
  team_id       TEXT,
  business      TEXT        NOT NULL,
  contact_name  TEXT,
  email         TEXT,
  phone         TEXT,
  deal          TEXT,
  price_cents   INTEGER,
  wants_options BOOLEAN     NOT NULL DEFAULT FALSE,
  dates         TEXT,
  note          TEXT,
  draft_id      TEXT,
  status        TEXT        NOT NULL DEFAULT 'new',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS university_bookings_university_idx ON university_bookings (university_id, created_at DESC);
