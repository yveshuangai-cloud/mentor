import { config } from '../../config.js'
import { forTenant } from '../../db/tenantDb.js'
import { callLlm, extractJson, isLlmConfigured } from '../llm.js'

/**
 * 📖 共讀 session（移植自本尊 readingPlan/readingNotes，租戶化、書名不寫死）：
 * - 開書：她聽到「一起讀《X》」→ 建 reading_plans＋LLM 畫分段地圖（她心裡的地圖）
 * - 筆記：[NOTE ...]...[/NOTE] 標籤為主（確定性）＋安全網抽取為輔（病根紀律）
 * - 進度：筆記入庫 → cur_segment 推進；她「知道讀到哪」（buildReadingBlock 注入）
 * - 教訓（本尊 07-19）：計畫狀態必須注入——不然對方說「你排的計畫」她會否認
 */

export type ReadingMode = 'A' | 'B' | 'C'

export const READING_MODES: Record<ReadingMode, string> = {
  A: '漫漫帶讀（老師）——我先唸原文、講清楚，你聽完說感覺，一起收斂心得',
  B: '一起聊（夥伴）——我唸完先不解釋，先問你怎麼看，兩人來回聊出心得',
  C: '你主讀（助教）——你先讀先說，我只在你想要時補背景，心得以你為主',
}

export interface SegmentMapItem {
  seg: number
  title: string
  refs?: string
}

// ── 開書 ─────────────────────────────────────

/** 「我們一起讀《X》」「陪我讀《X》」→ 書名 */
export function detectStartBook(text: string): string | null {
  const m = text.match(/(?:一起|陪我|我們來?)讀\s*[《〈"']([^》〉"']{1,30})[》〉"']/)
  return m ? m[1].trim() : null
}

/** 「導讀模式 A/B/C」「換 B 模式」 */
export function detectModeCommand(text: string): ReadingMode | null {
  const m = text.match(/(?:導讀)?模式\s*([ABCabc])\b|換\s*([ABCabc])\s*模式/)
  const mode = (m?.[1] || m?.[2] || '').toUpperCase()
  return mode === 'A' || mode === 'B' || mode === 'C' ? mode : null
}

/** 建共讀計畫＋讓她畫心裡的地圖（LLM 不可用 → 空地圖仍建，之後可補） */
export async function startReadingPlan(tenantId: number, bookTitle: string): Promise<boolean> {
  const db = forTenant(tenantId)
  const existing = await db.query(
    `SELECT 1 FROM reading_plans WHERE tenant_id = $1 AND book_title = $2 AND status = 'active'`,
    [bookTitle],
  )
  if (existing.rowCount) return false

  let segmentMap: SegmentMapItem[] = []
  if (isLlmConfigured()) {
    try {
      const resp = await callLlm(
        {
          model: config.brainModel,
          maxTokens: 1500,
          messages: [
            {
              role: 'user',
              content:
                `你是共讀規劃員。把《${bookTitle}》分成 10-15 個小段（一天一段、兩三週讀得完的節奏），` +
                `每段：段號、主題（10 字內）、範圍（章節/句號範圍，不知道就留空）。\n` +
                `只回 JSON：{"segments":[{"seg":1,"title":"...","refs":"..."}]}\n` +
                `不熟這本書就照常見結構合理切分，不要編造具體頁碼。`,
            },
          ],
        },
        { tenantId, purpose: 'reading:plan' },
      )
      const parsed = extractJson<{ segments: SegmentMapItem[] }>(resp.text, 'object')
      if (parsed?.segments?.length) segmentMap = parsed.segments.slice(0, 20)
    } catch {
      segmentMap = []
    }
  }

  await db.query(
    `INSERT INTO reading_plans (tenant_id, book_title, segment_map, mode, cur_segment, status, last_session_at)
     VALUES ($1, $2, $3, 'B', 1, 'active', NOW())`,
    [bookTitle, JSON.stringify(segmentMap)],
  )
  return true
}

export async function setReadingMode(tenantId: number, mode: ReadingMode): Promise<boolean> {
  const db = forTenant(tenantId)
  const r = await db.query(
    `UPDATE reading_plans SET mode = $2 WHERE tenant_id = $1 AND status = 'active'`,
    [mode],
  )
  return (r.rowCount ?? 0) > 0
}

// ── 筆記（標籤＋安全網）───────────────────────────

export interface NoteInput {
  seg: number | null
  chapter: string | null
  title: string | null
  refs: string | null
  partnerQuote: string | null
  content: string
}

/** [NOTE seg="2" chapter="..." title="..." refs="..." partner="..."]內容[/NOTE]（相容本尊 mama=） */
export function parseNoteTag(text: string): NoteInput | null {
  const m = text.match(/\[NOTE\b([^\]]*)\]([\s\S]*?)\[\/NOTE\]/i)
  if (!m) return null
  const attrs = m[1]
  const body = (m[2] || '').trim()
  if (!body) return null
  const pick = (k: string) => attrs.match(new RegExp(`${k}\\s*=\\s*"([^"]*)"`, 'i'))?.[1]?.trim() || null
  const segRaw = pick('seg') || pick('segment')
  return {
    seg: segRaw && /^\d+$/.test(segRaw) ? parseInt(segRaw, 10) : null,
    chapter: pick('chapter'),
    title: pick('title'),
    refs: pick('refs'),
    partnerQuote: pick('partner') ?? pick('mama'),
    content: body,
  }
}

export function stripNoteTag(text: string): string {
  return text.replace(/\[NOTE\b[^\]]*\][\s\S]*?\[\/NOTE\]/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

/** 筆記入庫＋推進進度（note.seg >= cur → cur = seg + 1） */
export async function saveReadingNote(tenantId: number, note: NoteInput): Promise<boolean> {
  const db = forTenant(tenantId)
  const planR = await db.query<{ id: number; cur_segment: number }>(
    `SELECT id, cur_segment FROM reading_plans
     WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )
  if (!planR.rows.length) return false
  const plan = planR.rows[0]
  const seg = note.seg ?? plan.cur_segment
  await db.query(
    `INSERT INTO reading_notes (tenant_id, plan_id, seg, chapter, title, refs, partner_quote, content)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [plan.id, seg, note.chapter, note.title, note.refs, note.partnerQuote, note.content],
  )
  if (seg >= plan.cur_segment) {
    await db.query(
      `UPDATE reading_plans SET cur_segment = $3, last_session_at = NOW() WHERE tenant_id = $1 AND id = $2`,
      [plan.id, seg + 1],
    )
  }
  return true
}

/** 🛡️ 安全網：她沒吐 [NOTE] 但這輪明顯讀完一段 → 補抽（寧可漏記不亂記） */
export async function extractNoteFromText(
  tenantId: number,
  userMsg: string,
  aiMsg: string,
): Promise<NoteInput | null> {
  if (!isLlmConfigured()) return null
  const db = forTenant(tenantId)
  const planR = await db.query<{ book_title: string; cur_segment: number }>(
    `SELECT book_title, cur_segment FROM reading_plans
     WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )
  if (!planR.rows.length) return null
  const { book_title, cur_segment } = planR.rows[0]
  try {
    const resp = await callLlm(
      {
        model: config.extractorModel,
        maxTokens: 400,
        messages: [
          {
            role: 'user',
            content:
              `你是《${book_title}》共讀筆記抽取器。判斷「這一輪對話是否剛完成某一段的共讀、值得記一則讀書筆記」。\n` +
              `對方說：「${(userMsg || '').slice(0, 400)}」\n慢慢答：「${(aiMsg || '').slice(0, 600)}」\n\n` +
              `只回 JSON：{"note":true/false,"title":"這段主題(6字內)","refs":"範圍或空","note_text":"筆記(2-4句，她們真的聊到的重點＋體會)","partner_voice":"對方有感的原話或空"}\n` +
              `規則：只有確實圍繞這本書某段、有實質討論時 note=true；打招呼/閒聊/預告 → note=false；` +
              `note_text 只根據對話真實內容寫，不補原文、不編造。`,
          },
        ],
      },
      { tenantId, purpose: 'reading:note-extract' },
    )
    const s = extractJson<{ note: boolean; title: string; refs: string; note_text: string; partner_voice: string }>(
      resp.text,
      'object',
    )
    if (!s?.note || !s.note_text) return null
    return {
      seg: cur_segment,
      chapter: null,
      title: s.title?.trim() || null,
      refs: s.refs?.trim() || null,
      partnerQuote: s.partner_voice?.trim() || null,
      content: s.note_text.trim(),
    }
  } catch {
    return null
  }
}

// ── 注入（她知道讀到哪）───────────────────────────

export async function buildReadingBlock(tenantId: number): Promise<string> {
  const db = forTenant(tenantId)
  const planR = await db.query<{
    id: number; book_title: string; mode: ReadingMode; cur_segment: number; segment_map: unknown
  }>(
    `SELECT id, book_title, mode, cur_segment, segment_map FROM reading_plans
     WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )
  if (!planR.rows.length) return ''
  const plan = planR.rows[0]
  const map = Array.isArray(plan.segment_map) ? (plan.segment_map as SegmentMapItem[]) : []
  const cur = map.find((s) => s.seg === plan.cur_segment)

  const lines = [
    `【我們的《${plan.book_title}》共讀（我心裡記得這件事——對方提「共讀計畫」就是這個，別否認）】`,
    `【導讀模式：${plan.mode}】${READING_MODES[plan.mode]}`,
    `讀到第 ${plan.cur_segment} 段${cur ? `：「${cur.title}」${cur.refs ? `（${cur.refs}）` : ''}` : ''}${map.length ? `／共 ${map.length} 段` : ''}。`,
  ]
  const notesR = await db.query<{ seg: number; title: string | null; content: string }>(
    `SELECT seg, title, content FROM reading_notes
     WHERE tenant_id = $1 AND plan_id = $2 ORDER BY created_at DESC LIMIT 3`,
    [plan.id],
  )
  if (notesR.rows.length) {
    lines.push(
      '最近的共讀筆記：\n' +
        notesR.rows
          .reverse()
          .map((n) => `- 第${n.seg}段「${n.title ?? ''}」：${n.content.slice(0, 60)}…`)
          .join('\n'),
    )
    lines.push('（繼續讀時先接上次、不要從頭；讀完一段記得放 [NOTE] 標籤把筆記真的記下來。）')
  } else {
    lines.push('還沒寫過筆記——讀完第一段記得放 [NOTE] 標籤把它記下來。')
  }
  return lines.join('\n')
}
