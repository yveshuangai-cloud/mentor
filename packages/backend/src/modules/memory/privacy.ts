import { platformQuery } from '../../db/index.js'
import { forTenant } from '../../db/tenantDb.js'

export type MemoryCommandResult = { handled: false } | { handled: true; reply: string }

function escapedLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&')
}

/** Deterministic privacy commands. They never pass through the LLM. */
export async function handleMemoryCommand(
  tenantId: number,
  userId: number,
  message: string,
): Promise<MemoryCommandResult> {
  if (/^刪除我的所有記憶[。.!！]?$/.test(message)) {
    return {
      handled: true,
      reply: '這會刪除你的對話、長期記憶、文件與向量索引，而且無法復原。若確定，請完整輸入「確認刪除我的所有記憶」。',
    }
  }

  if (/^確認刪除我的所有記憶[。.!！]?$/.test(message)) {
    const db = forTenant(tenantId)
    await db.withTransaction(async (q) => {
      await q(
        `DELETE FROM memory_topic_links l USING learned_facts f
         WHERE l.tenant_id = $1 AND f.tenant_id = $1 AND l.source_type = 'learned_fact'
           AND l.source_id = f.id AND f.user_id = $2`,
        [userId],
      )
      await q(
        `DELETE FROM memory_topic_links l USING conversations c
         WHERE l.tenant_id = $1 AND c.tenant_id = $1 AND l.source_type = 'conversation'
           AND l.source_id = c.id AND c.user_id = $2`,
        [userId],
      )
      await q(`DELETE FROM document_chunks WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM uploaded_documents WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM memory_vectors WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM distilled_memories WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM memory_topics WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM learned_facts WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM promises WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM scheduled_events WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM proactive_history WHERE tenant_id = $1 AND user_id = $2`, [userId])
      await q(`DELETE FROM conversations WHERE tenant_id = $1 AND user_id = $2`, [userId])
    })
    return { handled: true, reply: '已刪除屬於你的對話、記憶、文件與向量索引。家庭共享且由其他人建立的內容不受影響。' }
  }

  const forget = message.match(/^(?:忘記|刪除記憶)[：:]\s*(.{2,200})$/s)
  if (!forget) return { handled: false }
  const needle = forget[1].trim()
  const pattern = `%${escapedLike(needle)}%`
  const db = forTenant(tenantId)
  const deleted = await db.withTransaction(async (q) => {
    const candidates = await q<{ id: number }>(
      `SELECT id FROM learned_facts
       WHERE tenant_id = $1 AND user_id = $2 AND visibility = 'private'
         AND content ILIKE $3 ESCAPE '\\'`,
      [userId, pattern],
    )
    const ids = candidates.rows.map((row) => row.id)
    if (!ids.length) return 0
    await q(
      `DELETE FROM memory_topic_links
       WHERE tenant_id = $1 AND source_type = 'learned_fact' AND source_id = ANY($2::bigint[])`,
      [ids],
    )
    await q(
      `DELETE FROM memory_vectors
       WHERE tenant_id = $1 AND source_type = 'learned_fact' AND source_id = ANY($2::bigint[])`,
      [ids],
    )
    await q(
      `DELETE FROM learned_facts
       WHERE tenant_id = $1 AND user_id = $2 AND id = ANY($3::bigint[])`,
      [userId, ids],
    )
    return ids.length
  })
  return {
    handled: true,
    reply: deleted ? `已忘記 ${deleted} 條與「${needle}」相符的私人記憶，向量索引也同步刪除了。` : `我沒有找到與「${needle}」相符的私人記憶。`,
  }
}

export async function runMemoryRetentionSweep(): Promise<{
  documents: number
  facts: number
  vectors: number
}> {
  const documents = await platformQuery(`DELETE FROM uploaded_documents WHERE expires_at <= NOW()`)
  const facts = await platformQuery(
    `DELETE FROM learned_facts
     WHERE (expires_at IS NOT NULL AND expires_at <= NOW())
        OR (status IN ('decayed','superseded') AND created_at < NOW() - INTERVAL '90 days')`,
  )
  const vectors = await platformQuery(
    `DELETE FROM memory_vectors v
     WHERE v.source_type = 'learned_fact'
       AND NOT EXISTS (
         SELECT 1 FROM learned_facts f
         WHERE f.tenant_id = v.tenant_id AND f.id = v.source_id AND f.status = 'active'
       )`,
  )
  return {
    documents: documents.rowCount ?? 0,
    facts: facts.rowCount ?? 0,
    vectors: vectors.rowCount ?? 0,
  }
}
