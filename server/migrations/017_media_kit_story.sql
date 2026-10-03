-- 017_media_kit_story.sql
-- What a brand gets and who the athlete is, on the media kit. Every field is
-- optional and renders only when it holds something (public/media-kit.html).
-- Idempotent; runs on every boot.
--
-- What you get: deliverables (a short list), a price in one of three shapes
-- (price_mode 'exact' | 'range' | 'from' with price_low / price_high in whole
-- dollars, or none), and a one-line ask.
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS deliverables JSONB;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS price_mode TEXT;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS price_low INTEGER;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS price_high INTEGER;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS ask_line TEXT;
-- The athlete as a person.
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS hometown TEXT;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS class_year TEXT;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS major TEXT;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS bio_line TEXT;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS worked_with JSONB;
