import { forTenant } from '../../db/tenantDb.js'

/**
 * 🧠 記憶召喚（brain 每輪注入；本尊五層的 L1/L2/結構層，向量層之後補）：
 * - 常駐知識（learned_facts，working 層 + 高重要度 semantic）
 * - 主題索引 L1（memory_topics 印象）
 * - 默契精華 L2（distilled_memories 當前版，依 importance）
 * 被召喚的條目 fire-and-forget 記 recall（餵 nightly 鞏固）。
 */

export interface MemoryBlocks {
  learnedKnowledge: string
  topicIndex: string
  distilledEssence: string
}

const FACTS_LIMIT = 15
const DISTILLED_LIMIT = 12

export async function loadMemoryBlocks(tenantId: number): Promise<MemoryBlocks> {
  const db = forTenant(tenantId)

  const [factsR, topicsR, distilledR] = await Promise.all([
    db.query<{ id: number; category: string; content: string }>(
      `SELECT id, category, content FROM learned_facts
       WHERE tenant_id = $1 AND status = 'active' AND importance_score >= 0.4
         AND memory_layer IN ('working','semantic')
       ORDER BY (memory_layer = 'working') DESC, importance_score DESC, created_at DESC
       LIMIT ${FACTS_LIMIT}`,
    ),
    db.query<{ name: string; description: string | null }>(
      `SELECT name, description FROM memory_topics
       WHERE tenant_id = $1 AND NOT is_archived
       ORDER BY importance DESC, last_active_at DESC NULLS LAST LIMIT 20`,
    ),
    db.query<{ id: number; summary: string }>(
      `SELECT d.id, d.summary FROM distilled_memories d
       WHERE d.tenant_id = $1 AND d.kind = 'essence' AND d.superseded_by IS NULL
       ORDER BY d.importance DESC, d.updated_at DESC LIMIT ${DISTILLED_LIMIT}`,
    ),
  ])

  // 記 recall（餵鞏固；不等待、不影響回覆）
  const factIds = factsR.rows.map((f) => f.id)
  const distilledIds = distilledR.rows.map((d) => d.id)
  if (factIds.length) {
    void db
      .query(
        `UPDATE learned_facts SET recall_count = recall_count + 1, last_recalled_at = NOW()
         WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [factIds],
      )
      .catch(() => {})
  }
  if (distilledIds.length) {
    void db
      .query(
        `UPDATE distilled_memories SET recall_count = recall_count + 1, last_recalled_at = NOW()
         WHERE tenant_id = $1 AND id = ANY($2::int[])`,
        [distilledIds],
      )
      .catch(() => {})
  }

  return {
    learnedKnowledge: factsR.rows.length
      ? '# 我記得的（關於我的人的知識）\n' +
        factsR.rows.map((f) => `- (${f.category}) ${f.content}`).join('\n')
      : '',
    topicIndex: topicsR.rows.length
      ? '# 我們之間的主題（我心裡的索引）\n' +
        topicsR.rows.map((t) => `- ${t.name}${t.description ? `：${t.description}` : ''}`).join('\n')
      : '',
    distilledEssence: distilledR.rows.length
      ? '# 我們的默契（我消化過的精華，不是逐字紀錄）\n' +
        distilledR.rows.map((d) => `- ${d.summary}`).join('\n')
      : '',
  }
}
