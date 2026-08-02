import { config } from '../../config.js'
import { forTenant } from '../../db/tenantDb.js'
import { callLlm, extractJson, isLlmConfigured } from '../llm.js'

/**
 * 🧪 記憶蒸餾（移植自本尊 distillation，租戶化）：
 * 把同主題的 N 條原料（learned_facts + conversations）蒸成 3-10 條「精華」→ distilled_memories，
 * 舊蒸餾標 superseded_by（保留歷史）。這是「默契」的來源——她越處越熟的機制。
 *
 * 原則（沿本尊）：降維不是 summary；保留時序；解衝突；第一人稱。
 * 原料先收斂為 facts + conversations（concerns 表未搬入，之後補）。
 */

interface DistilledItem {
  summary: string
  source_ids: number[]
  importance: number
}

export interface DistillResult {
  topic_id: number
  topic_name: string
  distilled_count: number
}

export async function distillTopic(tenantId: number, topicId: number): Promise<DistillResult | null> {
  const db = forTenant(tenantId)
  const topicR = await db.query<{ id: number; name: string; description: string | null }>(
    `SELECT id, name, description FROM memory_topics
     WHERE tenant_id = $1 AND id = $2 AND NOT is_archived`,
    [topicId],
  )
  if (!topicR.rows.length) return null
  const topic = topicR.rows[0]

  const linksR = await db.query<{ source_type: string; source_id: number }>(
    `SELECT source_type, source_id FROM memory_topic_links WHERE tenant_id = $1 AND topic_id = $2`,
    [topicId],
  )
  const factIds = linksR.rows.filter((r) => r.source_type === 'learned_fact').map((r) => r.source_id)
  const convIds = linksR.rows.filter((r) => r.source_type === 'conversation').map((r) => r.source_id)

  const factsR = factIds.length
    ? await db.query<{ id: number; category: string; content: string; created_at: Date }>(
        `SELECT id, category, content, created_at FROM learned_facts
         WHERE tenant_id = $1 AND id = ANY($2::int[]) ORDER BY created_at ASC`,
        [factIds],
      )
    : { rows: [] as { id: number; category: string; content: string; created_at: Date }[] }

  // conversations 用 substr 防長文爆 prompt（本尊的 UTF-8 截斷雷來自壞資料；新庫先直取，壞列 try/catch skip）
  let convRows: { id: number; u: string; a: string; created_at: Date }[] = []
  if (convIds.length) {
    try {
      const r = await db.query<{ id: number; u: string; a: string; created_at: Date }>(
        `SELECT id, substr(coalesce(user_message,''), 1, 200) AS u,
                substr(coalesce(ai_response,''), 1, 200) AS a, created_at
         FROM conversations WHERE tenant_id = $1 AND id = ANY($2::int[]) ORDER BY id`,
        [convIds],
      )
      convRows = r.rows
    } catch {
      convRows = []
    }
  }

  const total = factsR.rows.length + convRows.length
  if (total === 0) return { topic_id: topicId, topic_name: topic.name, distilled_count: 0 }
  if (!isLlmConfigured()) return null

  const factsBlock = factsR.rows
    .map((f) => `[fact #${f.id} ${isoDate(f.created_at)}] (${f.category}) ${f.content}`)
    .join('\n')
  const convsBlock = convRows
    .map((c) => `[conv #${c.id} ${isoDate(c.created_at)}] 對方: ${c.u} | 我: ${c.a}`)
    .join('\n')

  const prompt = `你是慢慢的「記憶蒸餾員」。把同一主題的 ${total} 條原料，濃縮成 3-10 條精華事實。

【主題】${topic.name}
${topic.description ? `【現有印象】${topic.description}` : ''}

【原料 1 — Learned Facts (${factsR.rows.length} 條)】
${factsBlock || '(無)'}

【原料 2 — 對話片段 (${convRows.length} 條，按時序)】
${convsBlock || '(無)'}

【蒸餾規則】
1. 用「慢慢的第一人稱視角」（「對方在 ...」「對方跟我說 ...」「我記得 ...」）
2. **保留時序** —— 早期跟近期的事實要看得出來順序（用「最早 ... 然後 ... 最近 ...」或註明日期）
3. **解衝突** —— 如果原料有矛盾，合併成一條看得出時序的精華
4. **超越單一原料** —— 蒸餾不是 copy/paste，而是「我從這些原料整體看到的全貌」
5. **去除廢話** —— 「嗯嗯」「對啊」「好的」這類禮節性內容不入精華
6. **每條精華要有「為什麼這條值得我記住」** —— 不是流水帳，是對方在這個主題裡的「特徵」

【格式】
只回 JSON（不要 markdown 不要 code fence）：
{
  "distilled": [
    { "summary": "...", "source_ids": [123, 456], "importance": 0.9 }
  ],
  "topic_impression": "≤30 字，描述這個主題在對方生活中的份量"
}

精華數量 3-10 條，按 importance 排序（重要的在前）。`

  const resp = await callLlm(
    { model: config.brainModel, maxTokens: 3000, messages: [{ role: 'user', content: prompt }] },
    { tenantId, purpose: 'memory:distill' },
  )
  const parsed = extractJson<{ distilled: DistilledItem[]; topic_impression: string }>(resp.text, 'object')
  if (!parsed?.distilled?.length) return { topic_id: topicId, topic_name: topic.name, distilled_count: 0 }

  // 舊版本（superseded_by IS NULL 才是當前）
  const oldR = await db.query<{ id: number }>(
    `SELECT id FROM distilled_memories
     WHERE tenant_id = $1 AND topic_id = $2 AND kind = 'essence' AND superseded_by IS NULL`,
    [topicId],
  )

  const newIds: number[] = []
  for (const d of parsed.distilled) {
    const ins = await db.query<{ id: number }>(
      `INSERT INTO distilled_memories (tenant_id, topic_id, summary, source_ids, importance)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [topicId, d.summary, JSON.stringify(d.source_ids ?? []), Math.max(0, Math.min(1, d.importance ?? 0.5))],
    )
    newIds.push(ins.rows[0].id)
  }
  if (oldR.rows.length && newIds.length) {
    await db.query(
      `UPDATE distilled_memories SET superseded_by = $2, updated_at = NOW()
       WHERE tenant_id = $1 AND id = ANY($3::int[])`,
      [newIds[0], oldR.rows.map((r) => r.id)],
    )
  }
  if (parsed.topic_impression) {
    await db.query(
      `UPDATE memory_topics SET description = $2, updated_at = NOW() WHERE tenant_id = $1 AND id = $3`,
      [parsed.topic_impression.slice(0, 200), topicId],
    )
  }
  return { topic_id: topicId, topic_name: topic.name, distilled_count: newIds.length }
}

/** 只蒸「最近有新 link」的主題（cron 用；hours=0 表示全蒸） */
export async function distillChangedTopics(
  tenantId: number,
  onlyChangedSinceHours = 24,
): Promise<DistillResult[]> {
  const db = forTenant(tenantId)
  const topicsR = onlyChangedSinceHours
    ? await db.query<{ id: number }>(
        `SELECT DISTINCT t.id FROM memory_topics t
         JOIN memory_topic_links l ON l.topic_id = t.id
         WHERE t.tenant_id = $1 AND NOT t.is_archived
           AND l.added_at > NOW() - ($2 || ' hours')::interval`,
        [String(onlyChangedSinceHours)],
      )
    : await db.query<{ id: number }>(
        `SELECT id FROM memory_topics WHERE tenant_id = $1 AND NOT is_archived`,
      )

  const results: DistillResult[] = []
  for (const row of topicsR.rows) {
    try {
      const r = await distillTopic(tenantId, row.id)
      if (r) results.push(r)
    } catch (e) {
      console.error(`[distill] tenant=${tenantId} topic=${row.id} 失敗:`, (e as Error).message)
    }
  }
  return results
}

function isoDate(d: Date | string): string {
  return (typeof d === 'string' ? new Date(d) : d).toISOString().slice(0, 10)
}
