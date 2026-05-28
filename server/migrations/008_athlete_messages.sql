-- 008_athlete_messages.sql
-- Stores emails sent from athlete portals so agents can view them in the Email Inbox.
-- NOTE: all IDs in this app are TEXT (UUID), not INTEGER.

CREATE TABLE IF NOT EXISTS athlete_messages (
  id            SERIAL PRIMARY KEY,
  athlete_id    TEXT,
  athlete_name  TEXT,
  athlete_email TEXT,
  agent_id      TEXT,
  to_address    TEXT,
  subject       TEXT,
  body          TEXT,
  sent_at       TIMESTAMP DEFAULT NOW(),
  is_read       BOOLEAN DEFAULT FALSE
);

-- Fix existing tables that were created with incorrect INTEGER types.
-- USING cast is safe regardless of whether the column has data.
DO $$
BEGIN
  -- Fix athlete_id column
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'athlete_messages'
      AND column_name = 'athlete_id'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE athlete_messages ALTER COLUMN athlete_id TYPE TEXT USING athlete_id::TEXT;
  END IF;

  -- Fix agent_id column
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'athlete_messages'
      AND column_name = 'agent_id'
      AND data_type = 'integer'
  ) THEN
    ALTER TABLE athlete_messages ALTER COLUMN agent_id TYPE TEXT USING agent_id::TEXT;
  END IF;
END $$;
