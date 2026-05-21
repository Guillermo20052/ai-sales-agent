/**
 * Database initialization for local development.
 * Creates all tables required by the app. Idempotent (CREATE TABLE IF NOT EXISTS).
 * Run automatically in development on npm start; do not run in production.
 */

const pool = require("../services/db");

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    email VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255),
    password VARCHAR(255) NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT false,
    verification_token VARCHAR(255),
    subscription_status VARCHAR(50) NOT NULL DEFAULT 'inactive',
    terms_accepted BOOLEAN NOT NULL DEFAULT false,
    role VARCHAR(50) NOT NULL DEFAULT 'user',
    is_paid BOOLEAN NOT NULL DEFAULT false,
    message_count INTEGER NOT NULL DEFAULT 0,
    current_period_start TIMESTAMPTZ,
    stripe_customer_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    price_id VARCHAR(255),
    billing_cycle VARCHAR(50),
    subscription_amount INTEGER,
    current_period_end TIMESTAMPTZ,
    lifetime_revenue BIGINT DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS business_profiles (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    business_name VARCHAR(255),
    website_url TEXT,
    website_knowledge JSONB,
    website_training_status VARCHAR(50),
    website_last_trained_at TIMESTAMPTZ,
    services TEXT,
    hours TEXT,
    location TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS business_knowledge (
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
  )`,
  `CREATE TABLE IF NOT EXISTS conversations (
    id SERIAL PRIMARY KEY,
    business_id INTEGER REFERENCES business_profiles(id) ON DELETE CASCADE,
    visitor_id TEXT,
    user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
    role VARCHAR(50),
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id SERIAL PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    sender VARCHAR(50) NOT NULL,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS leads (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    message TEXT,
    email VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS business_products (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
    title TEXT,
    description TEXT,
    price TEXT,
    image_url TEXT,
    page_url TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS password_resets (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS refunds (
    id SERIAL PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stripe_refund_id VARCHAR(255),
    stripe_subscription_id VARCHAR(255),
    amount INTEGER,
    currency VARCHAR(10),
    reason TEXT,
    status VARCHAR(50),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS stripe_webhook_events (
    event_id VARCHAR(255) PRIMARY KEY,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  /* Ensure conversations has user_id/role/content if created by older script (e.g. ensurePublicAgentTables) */
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE CASCADE",
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS role VARCHAR(50)",
  "ALTER TABLE conversations ADD COLUMN IF NOT EXISTS content TEXT",
  /* Indexes: drop first so partial state can be repaired; then create */
  "DROP INDEX IF EXISTS idx_users_email",
  "CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)",
  "DROP INDEX IF EXISTS idx_business_profiles_user_id",
  "CREATE INDEX IF NOT EXISTS idx_business_profiles_user_id ON business_profiles(user_id)",
  "DROP INDEX IF EXISTS idx_conversations_business_id",
  "CREATE INDEX IF NOT EXISTS idx_conversations_business_id ON conversations(business_id)",
  "DROP INDEX IF EXISTS idx_conversations_user_id",
  "CREATE INDEX IF NOT EXISTS idx_conversations_user_id ON conversations(user_id)",
  "DROP INDEX IF EXISTS idx_messages_conversation_id",
  "CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id)",
  "DROP INDEX IF EXISTS idx_leads_user_id",
  "CREATE INDEX IF NOT EXISTS idx_leads_user_id ON leads(user_id)",
  // Leads schema upgrade: new columns
  "ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT",
  "ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT",
  "ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new'",
  "ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_id INTEGER",
  "ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_id INTEGER",
  // Leads FK: conversation_id → conversations(id)
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_conversation_id') THEN
      ALTER TABLE leads ADD CONSTRAINT fk_leads_conversation_id
        FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
    END IF;
  END $$`,
  // Leads FK: business_id → business_profiles(id)
  `DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_business_id') THEN
      ALTER TABLE leads ADD CONSTRAINT fk_leads_business_id
        FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
    END IF;
  END $$`,
  // Leads indexes
  "CREATE INDEX IF NOT EXISTS idx_leads_business_id ON leads(business_id)",
  "CREATE INDEX IF NOT EXISTS idx_leads_conversation_id ON leads(conversation_id)",
  "CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email)",
  "CREATE UNIQUE INDEX IF NOT EXISTS leads_unique_contact ON leads (business_id, conversation_id, email)",
  // Backfill business_id from business_profiles
  `UPDATE leads SET business_id = bp.id FROM business_profiles bp WHERE leads.user_id = bp.user_id AND leads.business_id IS NULL`,
  // Default status for existing rows
  "UPDATE leads SET status = 'new' WHERE status IS NULL",
  "DROP INDEX IF EXISTS idx_business_products_business_id",
  "CREATE INDEX IF NOT EXISTS idx_business_products_business_id ON business_products(business_id)",
  "DROP INDEX IF EXISTS idx_password_resets_user_id",
  "CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON password_resets(user_id)",
  "DROP INDEX IF EXISTS idx_password_resets_token",
  "CREATE INDEX IF NOT EXISTS idx_password_resets_token ON password_resets(token)",
  "DROP INDEX IF EXISTS idx_refunds_user_id",
  "CREATE INDEX IF NOT EXISTS idx_refunds_user_id ON refunds(user_id)",
  `CREATE TABLE IF NOT EXISTS admin_actions (
    id SERIAL PRIMARY KEY,
    admin_user_id INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    target_user_id INTEGER,
    metadata JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  )`,
  "CREATE INDEX IF NOT EXISTS idx_admin_actions_admin ON admin_actions(admin_user_id)",
  "CREATE INDEX IF NOT EXISTS idx_admin_actions_target ON admin_actions(target_user_id)",
  `CREATE TABLE IF NOT EXISTS ai_usage (
    id SERIAL PRIMARY KEY,
    business_id INTEGER NOT NULL REFERENCES business_profiles(id) ON DELETE CASCADE,
    model VARCHAR(128),
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  "CREATE INDEX IF NOT EXISTS idx_ai_usage_business_id ON ai_usage(business_id)",
  "CREATE INDEX IF NOT EXISTS idx_ai_usage_created_at ON ai_usage(created_at)",
];

async function initDb() {
  const client = await pool.connect();
  try {
    for (const sql of STATEMENTS) {
      await client.query(sql);
    }
    if (process.env.NODE_ENV === "development") {
      console.log("Database initialized successfully.");
    }
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { initDb };
