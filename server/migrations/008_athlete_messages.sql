-- 008_athlete_messages.sql
-- Stores emails sent from athlete portals so agents can view them in the Email Inbox.
CREATE TABLE IF NOT EXISTS athlete_messages (
  id           SERIAL PRIMARY KEY,
  athlete_id   INTEGER,
  athlete_name TEXT,
  athlete_email TEXT,
  agent_id     INTEGER,
  to_address   TEXT,
  subject      TEXT,
  body         TEXT,
  sent_at      TIMESTAMP DEFAULT NOW(),
  is_read      BOOLEAN DEFAULT FALSE
);
