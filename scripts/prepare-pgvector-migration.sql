-- Phase 6 pgvector preparation (non-breaking)
-- Run manually in environments where pgvector is available.
-- This does not remove existing JSONB embeddings; it adds vector columns/indexes for gradual migration.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE business_website_chunks
  ADD COLUMN IF NOT EXISTS embedding_vector vector(1536);

ALTER TABLE business_website_chunks
  ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'text-embedding-3-small';

ALTER TABLE business_website_chunks
  ADD COLUMN IF NOT EXISTS embedding_migrated_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_business_website_chunks_business_id_page_url
  ON business_website_chunks (business_id, page_url);

CREATE INDEX IF NOT EXISTS idx_business_website_chunks_embedding_vector_hnsw
  ON business_website_chunks
  USING hnsw (embedding_vector vector_cosine_ops);

-- Backfill strategy (manual, optional):
-- 1) Read rows where embedding_vector IS NULL and JSONB embedding exists.
-- 2) Cast JSON arrays to vector and update embedding_vector in batches.
-- 3) Mark embedding_migrated_at for each migrated row.
