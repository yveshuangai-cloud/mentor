-- Durable knowledge-portal uploads. Original files live in the dedicated GCS
-- bucket; Cloud SQL owns lifecycle, tenancy, extraction and retrieval state.

ALTER TABLE uploaded_documents
  ALTER COLUMN extracted_text DROP NOT NULL,
  ALTER COLUMN content_sha256 DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'line'
    CHECK (source IN ('line', 'portal', 'drive')),
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ready'
    CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed', 'duplicate', 'archived')),
  ADD COLUMN IF NOT EXISTS knowledge_type TEXT NOT NULL DEFAULT 'reference'
    CHECK (knowledge_type IN ('reference', 'policy', 'biography', 'skill_source')),
  ADD COLUMN IF NOT EXISTS retention_policy TEXT NOT NULL DEFAULT '30_days'
    CHECK (retention_policy IN ('30_days', '90_days', 'permanent')),
  ADD COLUMN IF NOT EXISTS mime_type TEXT,
  ADD COLUMN IF NOT EXISTS original_size_bytes BIGINT,
  ADD COLUMN IF NOT EXISTS gcs_bucket TEXT,
  ADD COLUMN IF NOT EXISTS gcs_object TEXT,
  ADD COLUMN IF NOT EXISTS gcs_generation TEXT,
  ADD COLUMN IF NOT EXISTS parser_name TEXT,
  ADD COLUMN IF NOT EXISTS parser_version TEXT,
  ADD COLUMN IF NOT EXISTS embedding_model TEXT,
  ADD COLUMN IF NOT EXISTS processing_error TEXT,
  ADD COLUMN IF NOT EXISTS duplicate_of_document_id BIGINT REFERENCES uploaded_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS processed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS uploaded_documents_status_idx
  ON uploaded_documents (tenant_id, user_id, status, updated_at DESC);

ALTER TABLE document_chunks
  ADD COLUMN IF NOT EXISTS page_number INTEGER,
  ADD COLUMN IF NOT EXISTS slide_number INTEGER,
  ADD COLUMN IF NOT EXISTS sheet_name TEXT,
  ADD COLUMN IF NOT EXISTS heading_path TEXT;

CREATE TABLE IF NOT EXISTS knowledge_ingest_jobs (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id BIGINT NOT NULL REFERENCES uploaded_documents(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'retry', 'done', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  locked_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id)
);

CREATE INDEX IF NOT EXISTS knowledge_ingest_jobs_due_idx
  ON knowledge_ingest_jobs (next_attempt_at, created_at)
  WHERE status IN ('pending', 'retry', 'processing');
