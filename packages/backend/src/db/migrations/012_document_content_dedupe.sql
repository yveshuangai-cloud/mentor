-- Keep a single knowledge-base copy of the same private/shared upload for one user.
-- Existing duplicates are removed before enforcing the invariant; chunks cascade.

WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY tenant_id, user_id, visibility, content_sha256
           ORDER BY created_at DESC, id DESC
         ) AS duplicate_rank
  FROM uploaded_documents
)
DELETE FROM uploaded_documents d
USING ranked r
WHERE d.id = r.id
  AND r.duplicate_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uploaded_documents_content_dedupe_idx
  ON uploaded_documents (tenant_id, user_id, visibility, content_sha256);
