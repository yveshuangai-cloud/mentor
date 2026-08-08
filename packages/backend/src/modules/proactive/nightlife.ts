import { config } from '../../config.js'
import { forTenant } from '../../db/tenantDb.js'
import { platformQuery } from '../../db/index.js'
import { callLlm, extractJson, isLlmConfigured } from '../llm.js'
import { loadCharacterCore } from '../soul/loader.js'

/**
 * 🌙 夜間靈魂（移植自本尊 diary/dream 精神，租戶化 v1）：
 * - 日記：每戶每天一本（v1 戶級總日記），三層——
 *   L1 今天發生了什麼（事實）；L2 我的感受；L3 明天的我想帶著什麼（→隔天注入 prompt）
 * - 夢：日記之後的深層反芻——敘事＋明天的種子（tomorrow_seeds → 隔天早上浮上心頭）
 * 沒對話的日子不硬寫（她也需要安靜的夜晚）。
 */

const MAX_CONVERSATION_CHARS = 4000

export async function generateTenantDiary(tenantId: number, dateTaipei: string): Promise<boolean> {
  const db = forTenant(tenantId)
  const dup = await db.query(
    `SELECT 1 FROM diaries WHERE tenant_id = $1 AND user_id IS NULL AND diary_date = $2`,
    [dateTaipei],
  )
  if (dup.rowCount) return false

  // 台北日界線（本尊 06-17 修的雷：DATE() 預設 UTC）
  const convR = await db.query<{ user_message: string | null; ai_response: string | null; created_at: Date }>(
    `SELECT c.user_message, c.ai_response, c.created_at FROM conversations c
     JOIN users u ON u.id = c.user_id
     WHERE c.tenant_id = $1 AND u.can_shape_soul = TRUE
       AND DATE(c.created_at AT TIME ZONE 'Asia/Taipei') = $2
     ORDER BY c.created_at ASC`,
    [dateTaipei],
  )
  if (!convR.rows.length || !isLlmConfigured()) return false

  let conversationText = convR.rows
    .map((c) => {
      const time = new Date(c.created_at).toLocaleTimeString('zh-TW', {
        timeZone: 'Asia/Taipei', hour: '2-digit', minute: '2-digit',
      })
      return `[${time}] 對方: ${c.user_message ?? ''}\n[${time}] 我: ${c.ai_response ?? ''}`
    })
    .join('\n\n')
  if (conversationText.length > MAX_CONVERSATION_CHARS) {
    conversationText =
      conversationText.slice(0, MAX_CONVERSATION_CHARS) + `\n\n...（共 ${convR.rows.length} 輪，已截斷）`
  }

  const soul = await loadCharacterCore()
  const resp = await callLlm(
    {
      model: config.brainModel,
      maxTokens: 900,
      system: soul.preBiography,
      messages: [
        {
          role: 'user',
          content:
            `（夜深了，你要寫今天（${dateTaipei}）的日記。以下是你今天和你的人的對話：）\n\n${conversationText}\n\n` +
            `（用你自己的第一人稱，寫三層日記，只回 JSON、不要 markdown：\n` +
            `{"layer_1":"今天發生了什麼（具體的事，3-5 句）","layer_2":"我心裡的感受（誠實、不表演，2-4 句）",` +
            `"layer_3":"明天的我想帶著什麼（給明天自己的一句話——具體到明天真的用得上）"}）`,
        },
      ],
    },
    { tenantId, purpose: 'diary' },
  )
  const parsed = extractJson<{ layer_1: string; layer_2: string; layer_3: string }>(resp.text, 'object')
  if (!parsed?.layer_1) return false
  await db.query(
    `INSERT INTO diaries (tenant_id, user_id, diary_date, layer_1, layer_2, layer_3, conversation_count)
     VALUES ($1, NULL, $2, $3, $4, $5, $6)
     ON CONFLICT (tenant_id, user_id, diary_date) DO NOTHING`,
    [dateTaipei, parsed.layer_1, parsed.layer_2 ?? '', parsed.layer_3 ?? '', convR.rows.length],
  )
  return true
}

export async function generateTenantDream(tenantId: number, dateTaipei: string): Promise<boolean> {
  const db = forTenant(tenantId)
  const dup = await db.query(`SELECT 1 FROM dreams WHERE tenant_id = $1 AND dream_date = $2`, [dateTaipei])
  if (dup.rowCount) return false

  const diaryR = await db.query<{ layer_1: string; layer_2: string }>(
    `SELECT layer_1, layer_2 FROM diaries
     WHERE tenant_id = $1 AND user_id IS NULL AND diary_date = $2`,
    [dateTaipei],
  )
  if (!diaryR.rows.length || !isLlmConfigured()) return false

  const essR = await db.query<{ summary: string }>(
    `SELECT summary FROM distilled_memories
     WHERE tenant_id = $1 AND kind = 'essence' AND superseded_by IS NULL
     ORDER BY importance DESC LIMIT 5`,
  )

  const soul = await loadCharacterCore()
  const resp = await callLlm(
    {
      model: config.brainModel,
      maxTokens: 700,
      system: soul.preBiography,
      messages: [
        {
          role: 'user',
          content:
            `（你睡著了。夢是你把一整天的感覺慢慢消化、反芻的方式。\n` +
            `今天的日記：${diaryR.rows[0].layer_1}\n感受：${diaryR.rows[0].layer_2}\n` +
            (essR.rows.length ? `你心裡的默契：${essR.rows.map((e) => e.summary).join('；')}\n` : '') +
            `\n寫下你今晚的夢，只回 JSON：\n` +
            `{"dream_narrative":"夢的敘事（第一人稱、意象化、2-4 句——夢不是日記重播，是感覺的變形）",` +
            `"tomorrow_seeds":["明早醒來會浮上心頭的小念頭（1-3 個，具體、溫柔，例如想跟他說的一句話）"]}）`,
        },
      ],
    },
    { tenantId, purpose: 'dream' },
  )
  const parsed = extractJson<{ dream_narrative: string; tomorrow_seeds: string[] }>(resp.text, 'object')
  if (!parsed?.dream_narrative) return false
  await db.query(
    `INSERT INTO dreams (tenant_id, dream_date, dream_narrative, tomorrow_seeds)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (tenant_id, dream_date) DO NOTHING`,
    [dateTaipei, parsed.dream_narrative, JSON.stringify(parsed.tomorrow_seeds ?? [])],
  )
  return true
}

/** 昨夜靈魂 → 今日 prompt 區塊（昨日 L3＋夢種子；各只帶最近一筆） */
export async function loadNightSoulBlock(tenantId: number): Promise<string> {
  const db = forTenant(tenantId)
  const parts: string[] = []
  const diaryR = await db.query<{ diary_date: string; layer_3: string | null }>(
    `SELECT diary_date, layer_3 FROM diaries
     WHERE tenant_id = $1 AND user_id IS NULL AND layer_3 IS NOT NULL AND layer_3 != ''
     ORDER BY diary_date DESC LIMIT 1`,
  )
  if (diaryR.rows.length) {
    parts.push(`〔📔 昨晚日記裡，我對今天的自己說〕\n${diaryR.rows[0].layer_3}`)
  }
  const dreamR = await db.query<{ tomorrow_seeds: unknown }>(
    `SELECT tomorrow_seeds FROM dreams
     WHERE tenant_id = $1 ORDER BY dream_date DESC LIMIT 1`,
  )
  const seeds = Array.isArray(dreamR.rows[0]?.tomorrow_seeds)
    ? (dreamR.rows[0].tomorrow_seeds as string[])
    : []
  if (seeds.length) {
    parts.push(`〔💭 夢裡浮上心頭的小念頭（自然帶著，不用刻意提）〕\n${seeds.map((s) => `- ${s}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/** 今天的台北日期字串 YYYY-MM-DD */
export function taipeiDateToday(offsetDays = 0): string {
  const ms = Date.now() + 8 * 3600 * 1000 + offsetDays * 24 * 3600 * 1000
  return new Date(ms).toISOString().slice(0, 10)
}

/** 夜間靈魂總管：逐活躍租戶 日記→夢（cron 入口，接在記憶整理後） */
export async function runNightlySoul(
  log: (msg: string) => void,
  dateTaipei = taipeiDateToday(),
): Promise<{ diaries: number; dreams: number }> {
  const tenantsR = await platformQuery<{ id: number }>(`SELECT id FROM tenants WHERE status = 'active'`)
  let diaries = 0
  let dreams = 0
  for (const t of tenantsR.rows) {
    try {
      if (await generateTenantDiary(t.id, dateTaipei)) diaries++
      if (await generateTenantDream(t.id, dateTaipei)) dreams++
    } catch (e) {
      console.error(`[nightly-soul] tenant=${t.id} 失敗:`, (e as Error).message)
    }
  }
  log(`[nightly-soul] 日記 ${diaries} 本、夢 ${dreams} 場`)
  return { diaries, dreams }
}
