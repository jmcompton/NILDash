-- 022_university_marketplace.sql
-- The school's own NIL marketplace page (Opendorse, INFLCR or its own), where
-- a business that booked on the NILDash booking page is sent to set up and pay
-- the deal. Set by staff (routes/campus.js). Safe to repeat.
ALTER TABLE universities ADD COLUMN IF NOT EXISTS nil_marketplace_name TEXT;
ALTER TABLE universities ADD COLUMN IF NOT EXISTS nil_marketplace_url TEXT;
