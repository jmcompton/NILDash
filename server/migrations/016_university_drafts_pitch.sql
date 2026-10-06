-- 016_university_drafts_pitch.sql
-- A draft can be a PITCH (no inventory item, no price) and carries who it goes
-- to and who it is from. University tables only (read 007 first). Every
-- statement is idempotent and runs on every boot.
--
-- The Cypress product's nightly card and on-demand pitch have no pricing
-- package (out of scope), so the inventory columns become optional; an ask
-- still fills them.
ALTER TABLE university_drafts ALTER COLUMN inventory_id DROP NOT NULL;
ALTER TABLE university_drafts ALTER COLUMN inventory_name DROP NOT NULL;
ALTER TABLE university_drafts ALTER COLUMN price_cents DROP NOT NULL;
ALTER TABLE university_drafts ALTER COLUMN team_id DROP NOT NULL;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'ask';
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS athlete_name TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS why TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS contact_name TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS contact_title TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS contact_email TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS contact_phone TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS contact_instagram TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS sender_user_id TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS sender_email TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS created_by TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS night DATE;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;
-- The card's rung (local, local-wide, social), and a social brand's program page.
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS lane TEXT;
ALTER TABLE university_drafts ADD COLUMN IF NOT EXISTS program_url TEXT;
CREATE INDEX IF NOT EXISTS university_drafts_night_idx ON university_drafts (university_id, night);
-- Staff title, for the sign-off (users is shared, so it is kept here, keyed by user).
CREATE TABLE IF NOT EXISTS university_staff (
  user_id        TEXT        PRIMARY KEY,
  university_id  TEXT        NOT NULL,
  title          TEXT,
  default_sender BOOLEAN     NOT NULL DEFAULT FALSE,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
