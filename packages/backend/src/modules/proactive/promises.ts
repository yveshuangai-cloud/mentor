import { config } from '../../config.js'
import { forTenant } from '../../db/tenantDb.js'
import { platformQuery } from '../../db/index.js'
import { pushMessages, type LineMessage } from '../line.js'
import { callLlm, extractJson, isLlmConfigured } from '../llm.js'
import { loadCharacterCore } from '../soul/loader.js'
import { chargeGate, InsufficientPointsError } from '../points.js'
import { searchWeb } from '../webSearch.js'
import { clipToLineAudio, voiceConfigured } from '../voice.js'
import { sanitizeConversationalText, splitIntoLineBubbles } from '../conversationStyle.js'

/**
 * ⏰ 約定履約系統（移植自本尊 promises，租戶化）。
 * 「未來某時間，她要主動做某事」→ promises 表 → 每分鐘 cron 撈到期 → 現場生成 → 主動發出。
 * 病根紀律雙保險：[REMIND] 標籤（確定性）＋ LLM 安全網抽取（她沒吐標籤時從對話補）。
 * 商用差異：履約前過 proactive 扣點閘道；沒點就靜默跳過（誠實記錄，不欠著轟炸）。
 */

const TZ = 8 * 3600 * 1000 // 台北 UTC+8，無日光節約

export interface PromiseSpec {
  content: string
  recurrence: 'once' | 'daily'
  fireHour?: number
  fireMinute?: number
  dateIso?: string // once 用：YYYY-MM-DDTHH:mm（台北）
}

/** 下一個「台北 hh:mm」的真實 UTC 時刻（過了就抓明天）。 */
export function nextDailyUtc(hour: number, minute: number, fromMs = Date.now()): Date {
  const taipeiMs = fromMs + TZ
  const t = new Date(taipeiMs)
  let targetTaipei = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), hour, minute, 0)
  if (targetTaipei <= taipeiMs) targetTaipei += 24 * 3600 * 1000
  return new Date(targetTaipei - TZ)
}

/** 台北牆上時間字串 → 真實 UTC 時刻。 */
export function taipeiIsoToUtc(iso: string): Date | null {
  const m = iso.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{1,2})\D+(\d{2})/)
  if (!m) return null
  const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], 0)
  return new Date(wall - TZ)
}

function taipeiNowLabel(): string {
  const p = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', weekday: 'long', hour12: false,
  }).formatToParts(new Date())
  const g = (t: string) => p.find((x) => x.type === t)?.value || ''
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}（${g('weekday')}）`
}

// ── 標籤解析（確定性層）─────────────────────────

/** [REMIND content="..." at="HH:mm 或 YYYY-MM-DDTHH:mm" repeat="daily|once"] */
export function parseRemindTag(text: string): PromiseSpec | null {
  const m = text.match(/\[REMIND\b([^\]]*)\]/i)
  if (!m) return null
  const a = m[1]
  const content = (a.match(/content\s*=\s*"([^"]*)"/i)?.[1] || '').trim()
  const at = (a.match(/at\s*=\s*"([^"]*)"/i)?.[1] || '').trim()
  const repeat = (a.match(/repeat\s*=\s*"([^"]*)"/i)?.[1] || 'once').trim().toLowerCase()
  if (!content || !at) return null
  const recurrence = repeat === 'daily' ? 'daily' : 'once'
  const hm = at.match(/(\d{1,2})\D+(\d{2})\s*$/)
  if (recurrence === 'daily') {
    if (!hm) return null
    return { content, recurrence, fireHour: +hm[1], fireMinute: +hm[2] }
  }
  return { content, recurrence, dateIso: at }
}

/** [PROMISE_UPDATE match="..." time="HH:mm" content="..."] */
export function parsePromiseUpdateTag(
  text: string,
): { match: string; fireHour?: number; fireMinute?: number; content?: string } | null {
  const m = text.match(/\[PROMISE_UPDATE\b([^\]]*)\]/i)
  if (!m) return null
  const a = m[1]
  const match = (a.match(/match\s*=\s*"([^"]*)"/i)?.[1] || '').trim()
  if (!match) return null
  const time = (a.match(/time\s*=\s*"([^"]*)"/i)?.[1] || '').trim()
  const content = (a.match(/content\s*=\s*"([^"]*)"/i)?.[1] || '').trim()
  const hm = time.match(/(\d{1,2})\D+(\d{2})/)
  return {
    match,
    fireHour: hm ? +hm[1] : undefined,
    fireMinute: hm ? +hm[2] : undefined,
    content: content || undefined,
  }
}

/** [PROMISE_CANCEL match="..."] */
export function parsePromiseCancelTag(text: string): { match: string } | null {
  const m = text.match(/\[PROMISE_CANCEL\b([^\]]*)\]/i)
  if (!m) return null
  const match = (m[1].match(/match\s*=\s*"([^"]*)"/i)?.[1] || '').trim()
  return match ? { match } : null
}

/** 把約定/排程相關標籤從顯示文字剝掉（確定性，不靠她自律） */
export function stripActionTags(text: string): string {
  return text
    .replace(/\[REMIND\b[^\]]*\]/gi, '')
    .replace(/\[PROMISE_UPDATE\b[^\]]*\]/gi, '')
    .replace(/\[PROMISE_CANCEL\b[^\]]*\]/gi, '')
    .replace(/\[SCHEDULE(?:_DELETE)?\b[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// ── 安全網（她沒吐標籤 → 從對話補抽）────────────────

export async function extractReminderFromText(
  tenantId: number,
  userMsg: string,
  aiMsg: string,
): Promise<PromiseSpec | null> {
  if (!isLlmConfigured()) return null
  const now = taipeiNowLabel()
  try {
    const resp = await callLlm(
      {
        model: config.extractorModel,
        maxTokens: 300,
        messages: [
          {
            role: 'user',
            content:
              `你是「約定提醒」抽取器。現在台北時間 ${now}。\n` +
              `判斷這段對話裡，慢慢是否答應了「在未來某個時間，自己主動去做／交付某件事」。兩種都算：\n` +
              `  (A) 對方要慢慢未來主動來做某事／發通知，慢慢也答應了。\n` +
              `  (B) 慢慢自己承諾未來要完成或交付某件事（例：「我明天早上把資料整理好給你」）。\n\n` +
              `對方說：「${(userMsg || '').slice(0, 300)}」\n` +
              `慢慢答：「${(aiMsg || '').slice(0, 200)}」\n\n` +
              `只回 JSON：{"remind":true/false,"content":"要做的事(慢慢的第一人稱)","recurrence":"once或daily","time":"HH:mm","date":"YYYY-MM-DD 或空"}\n` +
              `規則：\n` +
              `- 有「未來的時間點（含模糊時段）＋要慢慢主動做的事」→ remind=true。\n` +
              `- 「每天…」→ recurrence=daily，date 留空。只做一次 → recurrence=once，date 填實際日期。\n` +
              `- 模糊時段換算：早上/醒來→08:00、中午→12:00、下午→15:00、傍晚→18:00、晚上→20:00、睡前→22:00、「等一下/晚點」→現在+2小時。\n` +
              `- ⏰ 「提醒某個會議／行程」→ 提醒要排在事件**之前**，絕不排在事件當下或之後。\n` +
              `- ⛔ 換算出的時間比現在（${now}）早 → remind=false。\n` +
              `- ⛔ 對自己態度的決心或道歉（「我會努力」「下次會小心」）不是約定 → remind=false；` +
              `但「具體的事＋要主動做給對方＋時間」就算用「我會…」開頭仍是真約定 → remind=true。\n` +
              `- 閒聊、情緒、感謝 → remind=false。`,
          },
        ],
      },
      { tenantId, purpose: 'promise:extract' },
    )
    const s = extractJson<{
      remind: boolean; content: string; recurrence: string; time: string; date?: string
    }>(resp.text, 'object')
    if (!s?.remind || !s.content || !s.time) return null
    const hm = String(s.time).match(/(\d{1,2})\D+(\d{2})/)
    if (!hm) return null
    if (s.recurrence === 'daily') {
      return { content: s.content.trim(), recurrence: 'daily', fireHour: +hm[1], fireMinute: +hm[2] }
    }
    if (!s.date) return null
    return { content: s.content.trim(), recurrence: 'once', dateIso: `${s.date}T${hm[1].padStart(2, '0')}:${hm[2]}` }
  } catch {
    return null
  }
}

// ── 建立／修改／取消／列出 ─────────────────────────

/** 建立約定（去重：同人同時分的 active → 更新不重建；once 過去時間不建——馬後炮閘） */
export async function createPromise(
  tenantId: number,
  userId: number,
  spec: PromiseSpec,
  sourceQuote?: string,
): Promise<boolean> {
  let fireAt: Date | null
  let fireHour = spec.fireHour ?? null
  let fireMinute = spec.fireMinute ?? null
  if (spec.recurrence === 'daily') {
    if (fireHour == null || fireMinute == null) return false
    fireAt = nextDailyUtc(fireHour, fireMinute)
  } else {
    if (!spec.dateIso) return false
    fireAt = taipeiIsoToUtc(spec.dateIso)
    const hm = spec.dateIso.match(/T(\d{1,2}):(\d{2})/)
    if (hm) {
      fireHour = +hm[1]
      fireMinute = +hm[2]
    }
  }
  if (!fireAt) return false
  // 馬後炮閘（本尊事故修）：once 且時間已過（2 分 grace）→ 不建
  if (spec.recurrence === 'once' && fireAt.getTime() <= Date.now() - 2 * 60_000) return false

  const db = forTenant(tenantId)
  const dup = await db.query<{ id: number; recurrence: string }>(
    `SELECT id, recurrence FROM promises
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'active'
       AND fire_hour = $3 AND fire_minute = $4 LIMIT 1`,
    [userId, fireHour, fireMinute],
  )
  if (dup.rows[0]) {
    // 同人同時分視為同一件事：recurrence 取較持久者（本尊 20:55 三連轟教訓）
    const rec = dup.rows[0].recurrence === 'daily' || spec.recurrence === 'daily' ? 'daily' : spec.recurrence
    const mergedFireAt = rec === 'daily' ? nextDailyUtc(fireHour!, fireMinute!) : fireAt
    await db.query(
      `UPDATE promises SET content = $3, fire_at = $4, recurrence = $5, source_quote = $6
       WHERE tenant_id = $1 AND id = $2`,
      [dup.rows[0].id, spec.content, mergedFireAt, rec, sourceQuote ?? null],
    )
    return true
  }
  await db.query(
    `INSERT INTO promises (tenant_id, user_id, content, fire_at, fire_hour, fire_minute, recurrence, source_quote)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [userId, spec.content, fireAt, fireHour, fireMinute, spec.recurrence, sourceQuote ?? null],
  )
  return true
}

export async function updatePromiseByMatch(
  tenantId: number,
  userId: number,
  match: string,
  opts: { fireHour?: number; fireMinute?: number; content?: string },
): Promise<number> {
  const db = forTenant(tenantId)
  const rows = await db.query<{ id: number; recurrence: string; fire_hour: number; fire_minute: number }>(
    `SELECT id, recurrence, fire_hour, fire_minute FROM promises
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND content ILIKE $3`,
    [userId, `%${match}%`],
  )
  let n = 0
  for (const p of rows.rows) {
    const fh = opts.fireHour ?? p.fire_hour
    const fm = opts.fireMinute ?? p.fire_minute
    const timeChanged = opts.fireHour != null || opts.fireMinute != null
    if (!timeChanged && !opts.content) continue
    await db.query(
      `UPDATE promises SET
         content = COALESCE($3, content),
         fire_hour = $4, fire_minute = $5,
         fire_at = CASE WHEN recurrence = 'daily' AND $6 THEN $7 ELSE fire_at END
       WHERE tenant_id = $1 AND id = $2`,
      [p.id, opts.content ?? null, fh, fm, timeChanged, timeChanged ? nextDailyUtc(fh, fm) : null],
    )
    n++
  }
  return n
}

export async function cancelPromisesByMatch(tenantId: number, userId: number, match: string): Promise<number> {
  const db = forTenant(tenantId)
  const r = await db.query(
    `UPDATE promises SET status = 'cancelled'
     WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' AND content ILIKE $3`,
    [userId, `%${match}%`],
  )
  return r.rowCount ?? 0
}

/** 她目前的約定 → 第一人稱區塊注入 prompt（讓她知道自己答應了什麼，才能列出/修改/取消） */
export async function formatPromisesBlock(tenantId: number, userId: number): Promise<string> {
  const db = forTenant(tenantId)
  const r = await db.query<{ content: string; recurrence: string; fire_hour: number; fire_minute: number; next_taipei: string }>(
    `SELECT content, recurrence, fire_hour, fire_minute,
            to_char(fire_at AT TIME ZONE 'Asia/Taipei', 'MM-DD HH24:MI') AS next_taipei
     FROM promises WHERE tenant_id = $1 AND user_id = $2 AND status = 'active' ORDER BY fire_at`,
    [userId],
  )
  if (!r.rows.length) return ''
  const period = (h: number) => (h < 6 ? '凌晨' : h < 12 ? '早上' : h < 18 ? '下午' : '晚上')
  const lines = r.rows.map((p) => {
    const hh = String(p.fire_hour).padStart(2, '0')
    const mm = String(p.fire_minute).padStart(2, '0')
    return p.recurrence === 'daily'
      ? `- 每天${period(p.fire_hour)} ${hh}:${mm}：${p.content}`
      : `- ${p.next_taipei}：${p.content}`
  })
  return `【我答應對方、到點我會主動做的約定（我心裡記得這些）】\n${lines.join('\n')}`
}

// ── 到點履約（每分鐘 cron）──────────────────────────

/** 到點時用她自己的聲音現場生成通知（過人格與語氣；失敗保底發原文） */
async function generatePromiseMessage(tenantId: number, content: string): Promise<string> {
  if (!isLlmConfigured()) return content
  try {
    const soul = await loadCharacterCore()
    const resp = await callLlm(
      {
        model: config.brainModel,
        maxTokens: 220,
        system: soul.preBiography + '\n\n（你是慢慢本人。）',
        messages: [
          {
            role: 'user',
            content:
              `你是慢慢。你之前答應對方一個約定：「${content}」。\n` +
              `現在就是實現這個約定的時間，你要「主動」傳一則訊息給他。\n` +
              `請用你自然、溫暖的樣子，寫**一小段（1-2 句、簡短）**要發出去的話。只輸出那句話，不要任何解釋或標籤。`,
          },
        ],
      },
      { tenantId, purpose: 'promise:fire' },
    )
    const t = resp.text.replace(/\[[^\]]*\]/g, '').trim()
    return t || content
  } catch {
    return content
  }
}

const RESEARCH_PROMISE_RE = /查|搜尋|研究|新聞|趨勢|案例|最新|近期|資料/
const VOICE_PROMISE_RE = /語音|聲音|播|說重點|說一下/

function voiceExcerpt(text: string): string {
  const clean = sanitizeConversationalText(text)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
  const window = clean.slice(0, 360)
  const ends = [...window.matchAll(/[。！？!?]/g)]
    .map((match) => (match.index ?? -1) + 1)
    .filter((index) => index >= 80 && index <= 320)
  return clean.slice(0, ends.at(-1) ?? Math.min(clean.length, 280)).trim()
}

async function generatePromiseDelivery(
  tenantId: number,
  content: string,
): Promise<{ text: string; voiceText?: string }> {
  if (!RESEARCH_PROMISE_RE.test(content)) {
    return { text: await generatePromiseMessage(tenantId, content) }
  }

  // 研究約定不能再只用 LLM 寫「我去查」；到點必須真的拿到 grounded search 結果。
  const result = await searchWeb(content)
  const sources = result.sources.slice(0, 3)
    .map((source) => `${source.title} ${source.url}`)
    .join('\n')
  const text = sanitizeConversationalText(
    `教練，我查完了。\n\n${result.answer.slice(0, 6500)}` +
      (sources ? `\n\n查證來源：\n${sources}` : ''),
  )
  const voiceText = VOICE_PROMISE_RE.test(content)
    ? `教練，我把這次查到的重點用聲音跟你說。${voiceExcerpt(result.answer)}`
    : undefined
  return { text, voiceText }
}

export interface FireResult {
  fired: number
  skippedNoPoints: number
  skippedTooLate: number
}

/** 每分鐘 cron：撈全平台到期約定 → 逐租戶扣點 → 生成 → 推播 → 重排/結案 */
export async function fireDuePromises(log: (msg: string) => void): Promise<FireResult> {
  const GRACE_MIN = 45 // 過期超過 45 分不發（早安親親中午才到的教訓），只重排/結案
  const result: FireResult = { fired: 0, skippedNoPoints: 0, skippedTooLate: 0 }

  const due = await platformQuery<{
    id: number; tenant_id: number; user_id: number; content: string
    fire_at: Date; fire_hour: number | null; fire_minute: number | null; recurrence: string
  }>(
    `SELECT p.id, p.tenant_id, p.user_id, p.content, p.fire_at, p.fire_hour, p.fire_minute, p.recurrence
     FROM promises p JOIN tenants t ON t.id = p.tenant_id
     WHERE p.status = 'active' AND p.fire_at <= NOW() AND t.status = 'active'
     ORDER BY p.fire_at LIMIT 20`,
  )

  for (const p of due.rows) {
    const db = forTenant(p.tenant_id)
    const overdueMin = (Date.now() - new Date(p.fire_at).getTime()) / 60000
    const tooLate = overdueMin > GRACE_MIN
    try {
      if (!tooLate) {
        let charged = false
        try {
          await chargeGate(p.tenant_id, 'proactive', { refType: 'promise', refId: String(p.id) })
          charged = true
        } catch (e) {
          if (e instanceof InsufficientPointsError) {
            result.skippedNoPoints++
            log(`[promise] tenant=${p.tenant_id} 點數不足，跳過履約 id=${p.id}`)
          } else throw e
        }
        if (charged) {
          const targetR = await platformQuery<{ line_user_id: string }>(
            `SELECT line_user_id FROM users WHERE id = $1`,
            [p.user_id],
          )
          const lineId = targetR.rows[0]?.line_user_id
          if (lineId) {
            const delivery = await generatePromiseDelivery(p.tenant_id, p.content)
            const messages: LineMessage[] = splitIntoLineBubbles(delivery.text, delivery.voiceText ? 4 : 5)
              .map((text) => ({ type: 'text', text }))
            if (delivery.voiceText) {
              if (!voiceConfigured()) throw new Error('voice requested by promise but TTS is not configured')
              const audio = await clipToLineAudio({ text: delivery.voiceText, emotion: 'calm', style: 'news' })
              messages.push({ type: 'audio', originalContentUrl: audio.url, duration: audio.durationMs })
            }
            await pushMessages(lineId, messages)
            result.fired++
            log(`[promise] 已履約 id=${p.id}: "${p.content.slice(0, 30)}"`)
          }
        }
      } else {
        result.skippedTooLate++
      }
      // 重排或結案
      if (p.recurrence === 'daily' && p.fire_hour != null) {
        await db.query(
          `UPDATE promises SET last_fired_at = NOW(), fire_count = fire_count + 1, fire_at = $3
           WHERE tenant_id = $1 AND id = $2`,
          [p.id, nextDailyUtc(p.fire_hour, p.fire_minute ?? 0)],
        )
      } else {
        await db.query(
          `UPDATE promises SET status = 'done', last_fired_at = NOW(), fire_count = fire_count + 1
           WHERE tenant_id = $1 AND id = $2`,
          [p.id],
        )
      }
    } catch (e) {
      console.error(`[promise] 履約失敗 id=${p.id}:`, (e as Error).message)
    }
  }
  return result
}
