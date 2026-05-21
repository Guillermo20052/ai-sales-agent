-- Idempotent lead creation: one lead per (business_id, conversation_id, email).
-- Run once: psql $DATABASE_URL -f scripts/add-leads-unique-contact-index.sql
-- Requires: business_id, conversation_id, email columns (from upgrade-leads-schema.sql).
-- If you have existing duplicate (business_id, conversation_id, email) rows, resolve them before running.
--
-- NOTE: For PostgreSQL 15+, use scripts/leads-unique-nulls-not-distinct.sql instead,
-- so that one lead per conversation is enforced when email is NULL (phone-only leads).

CREATE UNIQUE INDEX IF NOT EXISTS leads_unique_contact
ON leads (business_id, conversation_id, email);
