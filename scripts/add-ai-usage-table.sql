-- OpenAI token usage per tenant (cost visibility).
-- Run once: psql $DATABASE_URL -f scripts/add-ai-usage-table.sql

CREATE TABLE IF NOT EXISTS ai_usage (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
  model VARCHAR(128),
  prompt_tokens INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ai_usage_business_id ON ai_usage(business_id);
CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at);
