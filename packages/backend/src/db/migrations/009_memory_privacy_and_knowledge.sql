-- Memory privacy, lifecycle, document knowledge base, and the one-time Mantou identity repair.

ALTER TABLE learned_facts
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'family_shared')),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE memory_topics
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'family_shared'));

ALTER TABLE distilled_memories
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'family_shared')),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

ALTER TABLE memory_vectors
  ADD COLUMN IF NOT EXISTS user_id BIGINT REFERENCES users(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'family_shared'));

ALTER TABLE uploaded_documents
  ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'family_shared')),
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '30 days');

UPDATE memory_vectors v
SET user_id = f.user_id,
    visibility = f.visibility
FROM learned_facts f
WHERE v.tenant_id = f.tenant_id
  AND v.source_type = 'learned_fact'
  AND v.source_id = f.id
  AND (v.user_id IS NULL OR v.visibility IS DISTINCT FROM f.visibility);

CREATE INDEX IF NOT EXISTS learned_facts_visibility_idx
  ON learned_facts (tenant_id, user_id, visibility, status, created_at DESC);
CREATE INDEX IF NOT EXISTS memory_vectors_visibility_idx
  ON memory_vectors (tenant_id, user_id, visibility, created_at DESC);
CREATE INDEX IF NOT EXISTS uploaded_documents_visibility_idx
  ON uploaded_documents (tenant_id, user_id, visibility, created_at DESC);

CREATE TABLE IF NOT EXISTS document_chunks (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  document_id BIGINT NOT NULL REFERENCES uploaded_documents(id) ON DELETE CASCADE,
  visibility TEXT NOT NULL DEFAULT 'private'
    CHECK (visibility IN ('private', 'family_shared')),
  chunk_index INTEGER NOT NULL CHECK (chunk_index >= 0),
  citation TEXT NOT NULL,
  content TEXT NOT NULL,
  embedding REAL[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS document_chunks_visibility_idx
  ON document_chunks (tenant_id, user_id, visibility, document_id, chunk_index);

CREATE TABLE IF NOT EXISTS memory_repair_audit (
  id BIGSERIAL PRIMARY KEY,
  repair_key TEXT NOT NULL UNIQUE,
  affected_facts INTEGER NOT NULL,
  affected_vectors INTEGER NOT NULL,
  affected_conversations INTEGER NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
DECLARE
  repaired_facts INTEGER := 0;
  repaired_vectors INTEGER := 0;
  repaired_conversations INTEGER := 0;
BEGIN
  -- The production audit identified exactly 83 learned facts carrying the former
  -- character name. Select by the exact old token; do not alter natural phrases
  -- such as 「慢慢來」 elsewhere in source code or conversation history.
  WITH repaired AS (
    UPDATE learned_facts
    SET content = replace(content, '慢慢', '饅頭')
    WHERE strpos(content, '慢慢') > 0
    RETURNING tenant_id, id
  )
  SELECT count(*) INTO repaired_facts FROM repaired;

  WITH repaired AS (
    UPDATE memory_vectors v
    SET content = replace(v.content, '慢慢', '饅頭'),
        embedding = NULL
    WHERE strpos(v.content, '慢慢') > 0
    RETURNING id
  )
  SELECT count(*) INTO repaired_vectors FROM repaired;

  WITH repaired AS (
    UPDATE conversations
    SET ai_response = replace(ai_response, '慢慢', '饅頭')
    WHERE ai_response IS NOT NULL
      AND strpos(ai_response, '慢慢') > 0
      AND ai_response ~ '(我是|叫我|我叫|名叫|稱呼).*慢慢|慢慢.*(是我|是你的|本人)'
    RETURNING id
  )
  SELECT count(*) INTO repaired_conversations FROM repaired;

  INSERT INTO memory_repair_audit
    (repair_key, affected_facts, affected_vectors, affected_conversations, details)
  VALUES (
    '009-mantou-old-identity', repaired_facts, repaired_vectors, repaired_conversations,
    jsonb_build_object('expected_production_facts', 83, 'embeddings_invalidated_for_rebuild', repaired_vectors)
  )
  ON CONFLICT (repair_key) DO NOTHING;
END $$;
