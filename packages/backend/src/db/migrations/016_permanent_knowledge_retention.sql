-- Permanent knowledge is represented by expires_at = NULL. Migration 009 made
-- the legacy 30-day column NOT NULL; the portal introduced permanent retention,
-- so explicitly relax the constraint in a new forward-only migration.

ALTER TABLE uploaded_documents
  ALTER COLUMN expires_at DROP NOT NULL;
