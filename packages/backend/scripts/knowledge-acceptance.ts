import { autoMigrate, platformQuery, pool } from '../src/db/index.js'
import { loadRelevantDocumentContext } from '../src/modules/documents.js'

let passed = 0
let failed = 0

function check(name: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name}`)
  }
}

async function main(): Promise<void> {
  await autoMigrate((message) => console.log(`  ${message}`))

  const userA = (await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id, display_name) VALUES ('qa-user-a', 'QA A') RETURNING id`,
  )).rows[0].id
  const userB = (await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id, display_name) VALUES ('qa-user-b', 'QA B') RETURNING id`,
  )).rows[0].id
  const tenant = (await platformQuery<{ id: number }>(
    `INSERT INTO tenants (owner_user_id, status, genesis_at) VALUES ($1, 'active', now()) RETURNING id`,
    [userA],
  )).rows[0].id

  async function document(userId: number, name: string, hash: string, visibility: 'private' | 'family_shared', text: string, expiresAt: string | null = null): Promise<number> {
    return (await platformQuery<{ id: number }>(
      `INSERT INTO uploaded_documents
         (tenant_id, user_id, file_name, file_type, extracted_text, content_sha256, truncated,
          visibility, expires_at, source, status, retention_policy)
       VALUES ($1, $2, $3, 'md', $4, $5, FALSE, $6, $7::timestamptz, 'portal', 'ready',
               CASE WHEN $7::timestamptz IS NULL THEN 'permanent' ELSE '30_days' END)
       RETURNING id`,
      [tenant, userId, name, text, hash, visibility, expiresAt],
    )).rows[0].id
  }

  async function chunk(documentId: number, userId: number, visibility: 'private' | 'family_shared', index: number, content: string): Promise<void> {
    await platformQuery(
      `INSERT INTO document_chunks
         (tenant_id, user_id, document_id, visibility, chunk_index, citation, content)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenant, userId, documentId, visibility, index, `【qa，段落 ${index + 1}】`, content],
    )
  }

  const own = await document(userA, 'own.md', 'a'.repeat(64), 'private', 'AlphaProject')
  await chunk(own, userA, 'private', 0, 'AlphaProject launch plan')
  const otherPrivate = await document(userB, 'private.md', 'b'.repeat(64), 'private', 'BetaSecret')
  await chunk(otherPrivate, userB, 'private', 0, 'BetaSecret must stay private')
  const shared = await document(userB, 'shared.md', 'c'.repeat(64), 'family_shared', 'SharedPolicy')
  await chunk(shared, userB, 'family_shared', 0, 'SharedPolicy is visible to family')
  const expired = await document(userA, 'expired.md', 'd'.repeat(64), 'private', 'ExpiredKnowledge', '2020-01-01T00:00:00Z')
  await chunk(expired, userA, 'private', 0, 'ExpiredKnowledge must not surface')

  const ownContext = await loadRelevantDocumentContext(tenant, userA, 'AlphaProject')
  check('本人 ready/permanent 文件可檢索', ownContext.includes('AlphaProject launch plan'))
  const privateContext = await loadRelevantDocumentContext(tenant, userA, 'BetaSecret')
  check('同 tenant 的他人 private 文件不可檢索', !privateContext.includes('BetaSecret'))
  const sharedContext = await loadRelevantDocumentContext(tenant, userA, 'SharedPolicy')
  check('同 tenant 的 family_shared 文件可檢索', sharedContext.includes('SharedPolicy'))
  const expiredContext = await loadRelevantDocumentContext(tenant, userA, 'ExpiredKnowledge')
  check('過期文件不可檢索', !expiredContext.includes('ExpiredKnowledge'))

  const full = await document(userA, 'whole.md', 'e'.repeat(64), 'private', 'first second third')
  await chunk(full, userA, 'private', 0, 'first')
  await chunk(full, userA, 'private', 1, 'second')
  await chunk(full, userA, 'private', 2, 'third')
  const fullContext = await loadRelevantDocumentContext(tenant, userA, '請完整閱讀整份文件')
  check('完整閱讀依 chunk_index 合併全部內容', fullContext.indexOf('first') < fullContext.indexOf('second') && fullContext.indexOf('second') < fullContext.indexOf('third'))

  let duplicateBlocked = false
  try {
    await document(userA, 'same.md', 'a'.repeat(64), 'private', 'duplicate')
  } catch (error) {
    duplicateBlocked = (error as { code?: string }).code === '23505'
  }
  check('相同 user/visibility/hash 由唯一索引擋重複', duplicateBlocked)

  await platformQuery(
    `INSERT INTO knowledge_ingest_jobs (tenant_id, user_id, document_id) VALUES ($1, $2, $3)`,
    [tenant, userA, full],
  )
  await platformQuery('DELETE FROM uploaded_documents WHERE tenant_id = $1 AND id = $2', [tenant, full])
  const cascades = await platformQuery<{ chunks: number; jobs: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM document_chunks WHERE tenant_id = $1 AND document_id = $2) AS chunks,
       (SELECT COUNT(*)::int FROM knowledge_ingest_jobs WHERE tenant_id = $1 AND document_id = $2) AS jobs`,
    [tenant, full],
  )
  check('刪除文件同步 cascade chunks 與 ingest job', cascades.rows[0].chunks === 0 && cascades.rows[0].jobs === 0)

  console.log(`\n═══ 知識庫 DB 驗收：${passed} 過 / ${failed} 敗 ═══`)
  await pool.end()
  process.exit(failed ? 1 : 0)
}

main().catch(async (error) => {
  console.error('knowledge acceptance crashed:', error)
  await pool.end().catch(() => undefined)
  process.exit(1)
})
