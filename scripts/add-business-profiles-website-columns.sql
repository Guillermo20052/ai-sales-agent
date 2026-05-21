-- Add website training columns to business_profiles if they don't exist.
-- Run: psql your_database_name -f scripts/add-business-profiles-website-columns.sql

ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_url TEXT;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_knowledge JSONB;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_training_status TEXT;
ALTER TABLE business_profiles ADD COLUMN IF NOT EXISTS website_last_trained_at TIMESTAMPTZ;
