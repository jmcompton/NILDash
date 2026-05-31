-- 009_athlete_gmail.sql
-- Adds Gmail OAuth columns to the athletes table so athletes can connect
-- their personal Gmail account and send emails directly via the Gmail API.

ALTER TABLE athletes ADD COLUMN IF NOT EXISTS gmail_refresh_token TEXT;
ALTER TABLE athletes ADD COLUMN IF NOT EXISTS gmail_address        TEXT;
