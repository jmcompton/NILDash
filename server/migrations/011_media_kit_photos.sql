-- 011_media_kit_photos.sql
-- Add photo storage columns for the rebuilt Media Kit builder

ALTER TABLE media_kits ADD COLUMN IF NOT EXISTS action_shot_data TEXT;
-- Note: headshot_url already exists and will be used to store base64 headshot data URL
