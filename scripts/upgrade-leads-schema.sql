-- Leads schema upgrade: add columns, foreign keys, indexes, and backfill.
-- Safe to run multiple times (idempotent).

-- STEP 1: Add columns
ALTER TABLE leads ADD COLUMN IF NOT EXISTS name TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS phone TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';
ALTER TABLE leads ADD COLUMN IF NOT EXISTS conversation_id INTEGER;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS business_id INTEGER;

-- STEP 2: Foreign keys (conditional)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_conversation_id') THEN
    ALTER TABLE leads ADD CONSTRAINT fk_leads_conversation_id
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE SET NULL;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_leads_business_id') THEN
    ALTER TABLE leads ADD CONSTRAINT fk_leads_business_id
      FOREIGN KEY (business_id) REFERENCES business_profiles(id) ON DELETE CASCADE;
  END IF;
END $$;

-- STEP 3: Indexes
CREATE INDEX IF NOT EXISTS idx_leads_business_id ON leads(business_id);
CREATE INDEX IF NOT EXISTS idx_leads_conversation_id ON leads(conversation_id);
CREATE INDEX IF NOT EXISTS idx_leads_email ON leads(email);

-- STEP 4: Backfill business_id from business_profiles
UPDATE leads
SET business_id = bp.id
FROM business_profiles bp
WHERE leads.user_id = bp.user_id
  AND leads.business_id IS NULL;

-- STEP 5: Default status for existing rows
UPDATE leads SET status = 'new' WHERE status IS NULL;
