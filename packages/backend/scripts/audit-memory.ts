import pg from 'pg'

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required')
const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  const repair = await client.query(
      `SELECT repair_key, affected_facts, affected_vectors, affected_conversations
       FROM memory_repair_audit WHERE repair_key = '009-mantou-old-identity'`,
    )
  const facts = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE content LIKE '%慢慢%' OR content LIKE '%漫漫%')::int AS old_identity,
              count(*) FILTER (WHERE visibility = 'private')::int AS private,
              count(*) FILTER (WHERE visibility = 'family_shared')::int AS family_shared
       FROM learned_facts`,
    )
  const vectors = await client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE embedding IS NULL)::int AS missing_embedding,
              count(*) FILTER (WHERE content LIKE '%慢慢%' OR content LIKE '%漫漫%')::int AS old_identity,
              min(array_length(embedding, 1)) FILTER (WHERE embedding IS NOT NULL)::int AS min_dimensions,
              max(array_length(embedding, 1)) FILTER (WHERE embedding IS NOT NULL)::int AS max_dimensions
       FROM memory_vectors`,
    )
  const documents = await client.query(
      `SELECT (SELECT count(*)::int FROM uploaded_documents) AS documents,
              (SELECT count(*)::int FROM document_chunks) AS chunks`,
    )
  console.log(JSON.stringify({
    repair: repair.rows[0] ?? null,
    facts: facts.rows[0],
    vectors: vectors.rows[0],
    documents: documents.rows[0],
  }))
} finally {
  await client.end()
}
