-- 010_media_kits.sql
-- Media Kit builder: store per-athlete media kits and rate cards

CREATE TABLE IF NOT EXISTS media_kits (
  id SERIAL PRIMARY KEY,
  athlete_id TEXT NOT NULL UNIQUE,
  instagram_handle TEXT,
  instagram_followers INTEGER,
  instagram_engagement TEXT,
  tiktok_handle TEXT,
  tiktok_followers INTEGER,
  twitter_handle TEXT,
  twitter_followers INTEGER,
  bio TEXT,
  primary_color TEXT,
  secondary_color TEXT,
  headshot_url TEXT,
  slug TEXT UNIQUE,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS media_kit_rate_cards (
  id SERIAL PRIMARY KEY,
  media_kit_id INTEGER REFERENCES media_kits(id) ON DELETE CASCADE,
  service_type TEXT NOT NULL,
  price INTEGER NOT NULL,
  notes TEXT
);
