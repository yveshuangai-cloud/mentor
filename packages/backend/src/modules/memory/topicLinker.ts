import { config } from '../../config.js'
import { forTenant, type TenantDb } from '../../db/tenantDb.js'
import { callLlm, extractJson, isLlmConfigured } from '../llm.js'

/**
 * 🔗 Topic Linker（移植自本尊，租戶化）：
 * 每晚把新的 learned_facts / conversations 歸到 memory_topics（L1 索引）。
 * 冷啟動（本尊沒有的問題）：新租戶零主題 → linker 空轉。
 * 解法：proposeTopics 在「零主題」時降門檻（importance>=0.5、湊滿 3 條就開新主題）。
 */

interface Topic {
  id: number
  name: string
  description: string | null
}

const MAX_ITEMS_PER_CALL = 30
const CONV_BATCH_SIZE = 12
const SKIP = 'none'

async function loadTopics(db: TenantDb, userId: number): Promise<Topic[]> {
  const r = await db.query<Topic>(
    `SELECT id, name, description FROM memory_topics
     WHERE tenant_id = $1 AND NOT is_archived
       AND (user_id = $2 OR visibility = 'family_shared') ORDER BY id`,
    [userId],
  )
  return r.rows
}

// ── facts 歸主題 ─────────────────────────────────

export async function linkNewFacts(tenantId: number, userId: number): Promise<{ linked: number; skipped: number }> {
  const db = forTenant(tenantId)
  const topics = await loadTopics(db, userId)
  if (!topics.length || !isLlmConfigured()) return { linked: 0, skipped: 0 }

  const factsR = await db.query<{ id: number; category: string; content: string }>(
    `SELECT id, category, content FROM learned_facts
     WHERE tenant_id = $1 AND status = 'active'
       AND (user_id = $2 OR visibility = 'family_shared')
       AND NOT EXISTS (
         SELECT 1 FROM memory_topic_links l
         WHERE l.source_type = 'learned_fact' AND l.source_id = learned_facts.id
       )
     ORDER BY importance_score DESC, created_at DESC LIMIT 100`,
    [userId],
  )
  if (!factsR.rows.length) return { linked: 0, skipped: 0 }

  let linked = 0
  let skipped = 0
  for (let i = 0; i < factsR.rows.length; i += MAX_ITEMS_PER_CALL) {
    const batch = factsR.rows.slice(i, i + MAX_ITEMS_PER_CALL)
    const topicsBlock = topics
      .map((t) => `[topic #${t.id}] ${t.name}${t.description ? ' — ' + t.description : ''}`)
      .join('\n')
    const itemsBlock = batch
      .map((f) => `[learned_fact #${f.id}] (${f.category}) ${f.content.slice(0, 200)}`)
      .join('\n')

    const resp = await callLlm(
      {
        model: config.extractorModel,
        maxTokens: 2000,
        system: `你是饅頭的記憶整理員。
任務：把每個「新事實」歸到最相關的「主題」之一。
規則：
- 不確定就回 "${SKIP}"（寧可不歸也不要亂歸）
- 一個 item 只能歸到一個 topic（最相關的那個）
- 只看給你的 topic 列表，不可發明新主題
- 主題名字跟描述要實質符合，不是表面字詞

輸出 JSON array，**只有這個 array、沒有解釋、沒有 markdown**：
[
  {"source_id": 387, "topic": 2},
  {"source_id": 388, "topic": "${SKIP}"}
]`,
        messages: [{ role: 'user', content: `【主題清單】\n${topicsBlock}\n\n【新事實】\n${itemsBlock}\n\n請判斷：` }],
      },
      { tenantId, purpose: 'memory:link-facts' },
    )
    const verdicts = extractJson<{ source_id: number; topic: number | string }[]>(resp.text, 'array') ?? []
    for (const v of verdicts) {
      if (typeof v.topic !== 'number') {
        skipped++
        continue
      }
      await db.query(
        `INSERT INTO memory_topic_links (tenant_id, topic_id, source_type, source_id)
         VALUES ($1, $2, 'learned_fact', $3) ON CONFLICT DO NOTHING`,
        [v.topic, v.source_id],
      )
      linked++
    }
  }
  return { linked, skipped }
}

// ── conversations 歸主題 ─────────────────────────

const CONV_SKIP_PATTERNS = [/^\[(撥號卡片|語音通話|系統|圖片|語音)/, /^\s*$/]

export async function linkNewConversations(
  tenantId: number,
  userId: number,
  maxPerRun = 200,
): Promise<{ linked: number; skipped: number }> {
  const db = forTenant(tenantId)
  const topics = await loadTopics(db, userId)
  if (!topics.length || !isLlmConfigured()) return { linked: 0, skipped: 0 }

  const convR = await db.query<{ id: number; user_message: string | null; ai_response: string | null }>(
    `SELECT c.id, c.user_message, c.ai_response FROM conversations c
     JOIN users u ON u.id = c.user_id
     WHERE c.tenant_id = $1 AND c.user_id = $2 AND u.can_shape_soul = TRUE
       AND NOT EXISTS (
         SELECT 1 FROM memory_topic_links l
         WHERE l.source_type = 'conversation' AND l.source_id = c.id
       )
     ORDER BY c.created_at ASC LIMIT ${maxPerRun}`,
    [userId],
  )
  const valid = convR.rows.filter((c) => {
    const um = (c.user_message ?? '').trim()
    return um.length >= 3 && !CONV_SKIP_PATTERNS.some((p) => p.test(um))
  })
  if (!valid.length) return { linked: 0, skipped: convR.rows.length - valid.length }

  let linked = 0
  let skipped = convR.rows.length - valid.length
  for (let i = 0; i < valid.length; i += CONV_BATCH_SIZE) {
    const batch = valid.slice(i, i + CONV_BATCH_SIZE)
    const topicsBlock = topics
      .map((t) => `[topic #${t.id}] ${t.name}${t.description ? ' — ' + t.description : ''}`)
      .join('\n')
    const convsBlock = batch
      .map((c) => `[conv #${c.id}] 對方: ${(c.user_message ?? '').slice(0, 150)} | 我: ${(c.ai_response ?? '').slice(0, 150)}`)
      .join('\n')

    const resp = await callLlm(
      {
        model: config.extractorModel,
        maxTokens: 2500,
        system: `你是饅頭的記憶整理員。
任務：把每段對話歸到最相關的主題之一。
規則：
- 一段對話只能歸到一個主題（最相關的那個）
- 跨主題就選**主要**那個
- 太瑣碎、純社交（問安、表情符號、單一字回）→ 回 "${SKIP}"
- 不確定 → 回 "${SKIP}"
- 不可發明新主題、不可超出列表

輸出 JSON array（**只有這個 array、沒有解釋**）：
[
  {"source_id": 4090, "topic": 11},
  {"source_id": 4091, "topic": "${SKIP}"}
]`,
        messages: [{ role: 'user', content: `【主題清單】\n${topicsBlock}\n\n【對話】\n${convsBlock}\n\n判斷：` }],
      },
      { tenantId, purpose: 'memory:link-convs' },
    )
    const verdicts = extractJson<{ source_id: number; topic: number | string }[]>(resp.text, 'array') ?? []
    for (const v of verdicts) {
      if (typeof v.topic !== 'number') {
        skipped++
        continue
      }
      await db.query(
        `INSERT INTO memory_topic_links (tenant_id, topic_id, source_type, source_id)
         VALUES ($1, $2, 'conversation', $3) ON CONFLICT DO NOTHING`,
        [v.topic, v.source_id],
      )
      linked++
    }
  }
  return { linked, skipped }
}

// ── 新主題提案（含冷啟動）──────────────────────────

export async function proposeTopics(tenantId: number, userId: number): Promise<{ created: number; linked: number }> {
  const db = forTenant(tenantId)
  if (!isLlmConfigured()) return { created: 0, linked: 0 }
  const existing = await loadTopics(db, userId)
  // 冷啟動：零主題時降門檻，讓新租戶的第一批主題長得出來
  const minImportance = existing.length === 0 ? 0.5 : 0.7

  const orphanR = await db.query<{ id: number; category: string; content: string; importance_score: number }>(
    `SELECT id, category, content, importance_score FROM learned_facts
     WHERE tenant_id = $1 AND status = 'active' AND importance_score >= ${minImportance}
       AND (user_id = $2 OR visibility = 'family_shared')
       AND NOT EXISTS (
         SELECT 1 FROM memory_topic_links l
         WHERE l.source_type = 'learned_fact' AND l.source_id = learned_facts.id
       )
     ORDER BY importance_score DESC, created_at DESC LIMIT 50`,
    [userId],
  )
  if (orphanR.rows.length < 3) return { created: 0, linked: 0 }

  const existingBlock = existing
    .map((t) => `[topic #${t.id}] ${t.name}${t.description ? ' — ' + t.description : ''}`)
    .join('\n')
  const orphanBlock = orphanR.rows
    .map((f) => `[fact #${f.id}] (${f.category}, ${f.importance_score}) ${f.content.slice(0, 200)}`)
    .join('\n')

  const resp = await callLlm(
    {
      model: config.brainModel,
      maxTokens: 2000,
      system: `你是饅頭的記憶整理員。
以下是對方一些「沒有適合主題可歸」的事實。請看看它們有沒有共同主題。

提案 0-3 個新主題，每個必須：
- 對應 3 條以上 fact
- 跟現有主題明顯不同（不重複）
- 主題名要具體（「畢業典禮」「我的願望」，不是「日常生活」這種太籠統）
- description 一句話概括主題本質

不確定就回空 array — 寧可不提案不要亂提。

輸出 JSON（**只有這個 object、沒有解釋**）：
{
  "proposals": [
    { "name": "...", "description": "...", "importance": 0.0-1.0, "fact_ids": [123, 456, 789] }
  ]
}`,
      messages: [
        {
          role: 'user',
          content: `【現有主題（避免重複）】\n${existingBlock || '(無)'}\n\n【待認領的 facts】\n${orphanBlock}\n\n提案：`,
        },
      ],
    },
    { tenantId, purpose: 'memory:propose-topics' },
  )

  const parsed = extractJson<{
    proposals: { name: string; description: string; importance: number; fact_ids: number[] }[]
  }>(resp.text, 'object')
  const result = { created: 0, linked: 0 }
  for (const p of parsed?.proposals ?? []) {
    if (!p.name || !Array.isArray(p.fact_ids) || p.fact_ids.length < 3) continue
    const ins = await db.query<{ id: number }>(
      `INSERT INTO memory_topics (tenant_id, user_id, name, description, importance, last_active_at, visibility)
       VALUES ($1, $2, $3, $4, $5, NOW(), 'private')
       ON CONFLICT (tenant_id, user_id, name) DO NOTHING
       RETURNING id`,
      [userId, p.name.slice(0, 60), p.description?.slice(0, 200) ?? null, Math.max(0, Math.min(1, p.importance ?? 0.7))],
    )
    const topicId = ins.rows[0]?.id
    if (!topicId) continue
    result.created++
    for (const fid of p.fact_ids) {
      await db.query(
        `INSERT INTO memory_topic_links (tenant_id, topic_id, source_type, source_id)
         VALUES ($1, $2, 'learned_fact', $3) ON CONFLICT DO NOTHING`,
        [topicId, fid],
      )
      result.linked++
    }
  }
  return result
}
