import { platformQuery } from '../../db/index.js'

/**
 * 🧠 記憶鞏固（移植自本尊 memoryConsolidation）：純 SQL、$0 成本，nightly 跑全租戶。
 * - 升級：recall_count >= 3 → importance +0.1
 * - 衰減：30 天沒被想起 → importance −0.05
 * - 清理：importance <= 0.15 且 60 天以上 → status = decayed
 * - 三抽屜層升降：archival→semantic（被想起 3 次）；semantic→working（20 次且 importance>=0.95）；
 *   semantic→archival（0 次、30 天、importance<0.6）
 *
 * 全租戶一次掃（UPDATE 不跨租戶讀資料，無串門風險）。
 */

export interface ConsolidationResult {
  promoted: number
  decayed: number
  cleaned: number
  layer_shifts: number
}

export async function consolidateMemories(): Promise<ConsolidationResult> {
  const promoted = await platformQuery(
    `UPDATE learned_facts SET importance_score = LEAST(importance_score + 0.1, 1.0)
     WHERE status = 'active' AND recall_count >= 3 AND importance_score < 0.9`,
  )
  const decayed = await platformQuery(
    `UPDATE learned_facts SET importance_score = GREATEST(importance_score - 0.05, 0.1)
     WHERE status = 'active' AND importance_score > 0.2
       AND (
         (last_recalled_at IS NOT NULL AND last_recalled_at < NOW() - INTERVAL '30 days')
         OR (last_recalled_at IS NULL AND created_at < NOW() - INTERVAL '30 days')
       )`,
  )
  const cleaned = await platformQuery(
    `UPDATE learned_facts SET status = 'decayed'
     WHERE status = 'active' AND importance_score <= 0.15
       AND created_at < NOW() - INTERVAL '60 days'`,
  )
  const r1 = await platformQuery(
    `UPDATE learned_facts SET memory_layer = 'semantic'
     WHERE status = 'active' AND memory_layer = 'archival' AND recall_count >= 3`,
  )
  const r2 = await platformQuery(
    `UPDATE learned_facts SET memory_layer = 'working'
     WHERE status = 'active' AND memory_layer = 'semantic'
       AND recall_count >= 20 AND importance_score >= 0.95`,
  )
  const r3 = await platformQuery(
    `UPDATE learned_facts SET memory_layer = 'archival'
     WHERE status = 'active' AND memory_layer = 'semantic'
       AND recall_count = 0 AND importance_score < 0.6
       AND created_at < NOW() - INTERVAL '30 days'`,
  )
  return {
    promoted: promoted.rowCount ?? 0,
    decayed: decayed.rowCount ?? 0,
    cleaned: cleaned.rowCount ?? 0,
    layer_shifts: (r1.rowCount ?? 0) + (r2.rowCount ?? 0) + (r3.rowCount ?? 0),
  }
}
