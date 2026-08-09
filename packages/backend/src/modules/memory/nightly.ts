import { platformQuery } from '../../db/index.js'
import { linkNewFacts, linkNewConversations, proposeTopics } from './topicLinker.js'
import { distillChangedTopics } from './distillation.js'
import { consolidateMemories } from './consolidation.js'
import { reindexMissingMemories } from './vector.js'
import { runMemoryRetentionSweep } from './privacy.js'

/**
 * 夜間記憶整理總管（cron 入口）。順序沿本尊 nightly：
 * 歸主題（23:50）→ 蒸餾（00:30）→ 鞏固（23:30），這裡合成一次呼叫、逐租戶跑。
 * 任一租戶失敗不擋其他租戶。
 */

export interface NightlyMemorySummary {
  tenants: number
  facts_linked: number
  convs_linked: number
  topics_created: number
  topics_distilled: number
  vectors_rebuilt: number
  retention: { documents: number; facts: number; vectors: number }
  consolidation: { promoted: number; decayed: number; cleaned: number; layer_shifts: number }
}

export async function runNightlyMemory(log: (msg: string) => void): Promise<NightlyMemorySummary> {
  const tenantsR = await platformQuery<{ id: number }>(
    `SELECT id FROM tenants WHERE status = 'active'`,
  )
  const summary: NightlyMemorySummary = {
    tenants: tenantsR.rows.length,
    facts_linked: 0,
    convs_linked: 0,
    topics_created: 0,
    topics_distilled: 0,
    vectors_rebuilt: 0,
    retention: { documents: 0, facts: 0, vectors: 0 },
    consolidation: { promoted: 0, decayed: 0, cleaned: 0, layer_shifts: 0 },
  }

  for (const t of tenantsR.rows) {
    try {
      const rebuilt = await reindexMissingMemories(t.id)
      summary.vectors_rebuilt += rebuilt
      const users = await platformQuery<{ user_id: number }>(
        `SELECT user_id FROM tenant_members
         WHERE tenant_id = $1 AND status = 'confirmed' ORDER BY user_id`,
        [t.id],
      )
      for (const member of users.rows) {
        // Each person's private memories are organized separately; explicitly
        // family-shared material remains visible to every member.
        const proposed = await proposeTopics(t.id, member.user_id)
        summary.topics_created += proposed.created
        const facts = await linkNewFacts(t.id, member.user_id)
        summary.facts_linked += facts.linked
        const convs = await linkNewConversations(t.id, member.user_id)
        summary.convs_linked += convs.linked
        const distilled = await distillChangedTopics(t.id, member.user_id, 24)
        summary.topics_distilled += distilled.filter((d) => d.distilled_count > 0).length
        log(
          `[nightly-memory] tenant=${t.id} user=${member.user_id} vectors+${rebuilt} topics+${proposed.created} facts+${facts.linked} convs+${convs.linked} distilled=${distilled.length}`,
        )
      }
    } catch (e) {
      console.error(`[nightly-memory] tenant=${t.id} 失敗:`, (e as Error).message)
    }
  }

  summary.consolidation = await consolidateMemories()
  summary.retention = await runMemoryRetentionSweep()
  return summary
}
