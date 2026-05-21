-- Run this on your database so the public chat widget, dashboard, and training work.
-- Example: psql your_database_name -f scripts/init-public-agent-tables.sql

-- Business knowledge (AI training form: description, services, pricing, faqs, etc.)
CREATE TABLE IF NOT EXISTS business_knowledge (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  description TEXT,
  services TEXT,
  pricing TEXT,
  faqs TEXT,
  tone TEXT,
  website_url TEXT,
  instagram_url TEXT,
  facebook_url TEXT,
  restrictions TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id)
);

-- Conversations (public widget: one per visitor/business)
CREATE TABLE IF NOT EXISTS conversations (
  id SERIAL PRIMARY KEY,
  business_id INTEGER NOT NULL,
  visitor_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Messages (each message in a conversation)
CREATE TABLE IF NOT EXISTS messages (
  id SERIAL PRIMARY KEY,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leads (captured from widget when user shows buying intent)
CREATE TABLE IF NOT EXISTS leads (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message TEXT,
  email TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Optional: index for faster lookups
CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id);
