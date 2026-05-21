-- Embedding-backed chunks for semantic retrieval.
-- Run: psql your_database_name -f scripts/add-business-website-chunks-table.sql

CREATE TABLE IF NOT EXISTS business_website_chunks (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  page_url TEXT,
  page_type VARCHAR(50),
  content_chunk TEXT,
  embedding JSONB,
  extracted_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_website_chunks_business_id ON business_website_chunks(business_id);
