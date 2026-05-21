-- Ensure one lead per conversation when email is NULL (PostgreSQL 15+).
-- Run once: psql $DATABASE_URL -f scripts/leads-unique-nulls-not-distinct.sql
--
-- Problem: UNIQUE (business_id, conversation_id, email) treats NULL != NULL,
-- allowing duplicate phone-only leads for the same conversation.
-- Fix: Use NULLS NOT DISTINCT so one row per (business_id, conversation_id)
-- when email is NULL.

-- 1) Remove existing duplicate rows (keep one per business_id, conversation_id where email IS NULL)
DELETE FROM leads a
USING leads b
WHERE a.business_id = b.business_id
  AND a.conversation_id = b.conversation_id
  AND a.email IS NULL
  AND b.email IS NULL
  AND a.id > b.id;

-- 2) Drop the old unique index
DROP INDEX IF EXISTS leads_unique_contact;

-- 3) Create unique index with NULLs considered equal (Postgres 15+)
CREATE UNIQUE INDEX leads_unique_contact
ON leads (business_id, conversation_id, email) NULLS NOT DISTINCT;
