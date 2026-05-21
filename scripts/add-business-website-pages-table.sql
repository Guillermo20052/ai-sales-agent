-- Structured per-page website knowledge for Business AI.
-- Run: psql your_database_name -f scripts/add-business-website-pages-table.sql

CREATE TABLE IF NOT EXISTS business_website_pages (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  page_type VARCHAR(50) NOT NULL DEFAULT 'general',
  title TEXT,
  cleaned_content TEXT,
  metadata_json JSONB,
  importance_score NUMERIC(5,2) DEFAULT 0,
  content_hash VARCHAR(64),
  extracted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, url)
);

CREATE INDEX IF NOT EXISTS idx_business_website_pages_business_id ON business_website_pages(business_id);
CREATE INDEX IF NOT EXISTS idx_business_website_pages_page_type ON business_website_pages(business_id, page_type);
