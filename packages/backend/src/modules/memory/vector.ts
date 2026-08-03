import { config } from '../../config.js'
import { forTenant } from '../../db/tenantDb.js'

/**
 * 🔎 語意記憶層（本尊五層的向量層，商用重寫版）：
 * - 本尊用 Cloudflare Vectorize（metadata 過濾 fail-open ＋ godView 繞過 → 商用不照抄）。
 * - 商用版：embedding 存 memory_vectors（tenant_id 貫穿、wrapper 強制 → fail-closed 天然成立）。
 * - Embedding：Gemini text-embedding-004（768 維；沒設 key → 關鍵字 fallback，功能不斷）。
 * - 規模備註：每戶記憶量 < 幾千條，app 層 cosine 足夠；量大後遷 pgvector（介面不變）。
 */

export type EmbedFn = (texts: string[]) => Promise<number[][]>

let embedOverride: EmbedFn | null = null

/** 測試用：注入假 embedding（null 還原） */
export function setEmbedOverride(fn: EmbedFn | null): void {
  embedOverride = fn
}

export function embeddingConfigured(): boolean {
  return embedOverride !== null || config.geminiApiKey !== 'not-configured'
}

async function embed(texts: string[]): Promise<number[][]> {
  if (embedOverride) return embedOverride(texts)
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:batchEmbedContents?key=${config.geminiApiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((t) => ({
          model: 'models/text-embedding-004',
          content: { parts: [{ text: t.slice(0, 2000) }] },
        })),
      }),
    },
  )
  if (!res.ok) throw new Error(`Gemini embed HTTP ${res.status}`)
  const data = (await res.json()) as { embeddings: { values: number[] }[] }
  return data.embeddings.map((e) => e.values)
}

/** 收錄一條記憶（embedding 失敗不擋——存 content，之後仍可關鍵字搜到） */
export async function indexMemory(
  tenantId: number,
  sourceType: 'learned_fact' | 'conversation' | 'distilled',
  sourceId: number,
  content: string,
): Promise<void> {
  const db = forTenant(tenantId)
  let embedding: number[] | null = null
  if (embeddingConfigured()) {
    try {
      embedding = (await embed([content]))[0] ?? null
    } catch {
      embedding = null
    }
  }
  await db.query(
    `INSERT INTO memory_vectors (tenant_id, source_type, source_id, content, embedding)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (tenant_id, source_type, source_id)
       DO UPDATE SET content = EXCLUDED.content, embedding = EXCLUDED.embedding`,
    [sourceType, sourceId, content.slice(0, 1000), embedding],
  )
}

export interface SemanticHit {
  source_type: string
  source_id: number
  content: string
  score: number
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0
}

/**
 * 語意搜尋（該戶內；跨戶不可能——wrapper 強制 tenant_id）。
 * 有 embedding → cosine 排序；沒有 → 關鍵字重疊 fallback（確定性）。
 */
export async function semanticSearch(
  tenantId: number,
  query: string,
  limit = 5,
  minScore = 0.35,
): Promise<SemanticHit[]> {
  const db = forTenant(tenantId)

  if (embeddingConfigured()) {
    try {
      const [qVec] = await embed([query])
      const rows = await db.query<{ source_type: string; source_id: number; content: string; embedding: number[] | null }>(
        `SELECT source_type, source_id, content, embedding FROM memory_vectors
         WHERE tenant_id = $1 AND embedding IS NOT NULL
         ORDER BY created_at DESC LIMIT 2000`,
      )
      return rows.rows
        .map((r) => ({
          source_type: r.source_type,
          source_id: r.source_id,
          content: r.content,
          score: cosine(qVec, r.embedding ?? []),
        }))
        .filter((h) => h.score >= minScore)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    } catch {
      // embedding 端掛了 → 落到關鍵字 fallback，不斷線
    }
  }

  // 關鍵字 fallback：query 切詞（≥2 字）對 content 做重疊計分
  const keywords = query.split(/[，,。、！？!?\s]+/).flatMap((w) => {
    const out: string[] = []
    for (let len = 2; len <= Math.min(4, w.length); len++) {
      for (let i = 0; i + len <= w.length; i++) out.push(w.slice(i, i + len))
    }
    return out
  })
  if (!keywords.length) return []
  const rows = await db.query<{ source_type: string; source_id: number; content: string }>(
    `SELECT source_type, source_id, content FROM memory_vectors
     WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 2000`,
  )
  return rows.rows
    .map((r) => {
      const hits = keywords.filter((k) => r.content.includes(k)).length
      return { source_type: r.source_type, source_id: r.source_id, content: r.content, score: hits / keywords.length }
    })
    .filter((h) => h.score > 0.1)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
}

/** brain 注入用：跟當前訊息相關的舊記憶區塊 */
export async function buildSemanticBlock(tenantId: number, message: string): Promise<string> {
  try {
    const hits = await semanticSearch(tenantId, message, 5)
    if (!hits.length) return ''
    return (
      '# 跟這句話有關的舊記憶（語意想起來的）\n' +
      hits.map((h) => `- ${h.content}`).join('\n')
    )
  } catch {
    return ''
  }
}
