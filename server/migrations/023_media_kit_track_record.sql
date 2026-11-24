-- 023_media_kit_track_record.sql
-- The athlete's track record on the media kit (services/trackRecord): built
-- from closed deals, gifted product and delivered posts. On unless the agent
-- turns it off; any brand can be left off. Idempotent; runs on every boot.
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS show_track_record BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS track_hidden JSONB;
