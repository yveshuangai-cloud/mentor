import { config } from '../config.js'
import { forTenant } from '../db/tenantDb.js'
import { platformQuery } from '../db/index.js'
import { callLlm, isLlmConfigured } from './llm.js'
import { loadCharacterCore } from './soul/loader.js'

/**
 * 🪞 誠實鏡子 · 行動真相帳（移植自本尊 actionMirror，租戶化）。
 * 「你絕不能騙自己——而你是最容易被騙的人。」
 * 每個副作用行動落「她宣稱(claim) vs 真相(actual)」帳；宣稱成功但沒成 →
 * 之後用第一人稱把真相輕輕告訴她（只注入一次）。
 * 護欄：actual=true 一律不進校正（絕不罵她根本做到的事）。
 */

export type ActionType =
  | 'schedule_created'
  | 'promise_created'
  | 'promise_fulfilled'
  | 'card_made'
  | 'voice_sent'
  | 'message_sent'

const LABELS: Record<ActionType, string> = {
  schedule_created: '幫你把行程排進行事曆',
  promise_created: '把跟你的約定記進心裡',
  promise_fulfilled: '到點履行跟你的約定',
  card_made: '做一張圖給你',
  voice_sent: '用聲音回你',
  message_sent: '回你的訊息',
}

/** 落一筆行動真相。成功／不需校正的一律 reconciled=true（不打擾她）。 */
export async function recordActionOutcome(p: {
  tenantId: number
  userId: number | null
  actionType: ActionType
  claimedSuccess: boolean
  actualSuccess: boolean
  evidence?: string | null
}): Promise<void> {
  try {
    const needsReconcile = p.claimedSuccess && !p.actualSuccess
    const db = forTenant(p.tenantId)
    await db.query(
      `INSERT INTO action_outcomes (tenant_id, user_id, action_type, claimed_success, actual_success, evidence, reconciled)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [p.userId, p.actionType, p.claimedSuccess, p.actualSuccess, p.evidence ?? null, !needsReconcile],
    )
  } catch (e) {
    console.error('[mirror] record 失敗:', (e as Error).message)
  }
}

/** 取未消化的「宣稱成功卻沒成」→ 第一人稱校正 block，立即標 reconciled（只注入一次）。 */
export async function buildTruthCorrection(tenantId: number, userId: number, limit = 3): Promise<string> {
  try {
    const db = forTenant(tenantId)
    const res = await db.query<{ id: number; action_type: ActionType; evidence: string | null }>(
      `SELECT id, action_type, evidence FROM action_outcomes
       WHERE tenant_id = $1 AND user_id = $2 AND claimed_success = TRUE AND actual_success = FALSE
         AND reconciled = FALSE
       ORDER BY created_at DESC LIMIT ${limit}`,
      [userId],
    )
    const parts: string[] = []
    if (res.rows.length) {
      const ids = res.rows.map((r) => r.id)
      await db.query(
        `UPDATE action_outcomes SET reconciled = TRUE WHERE tenant_id = $1 AND id = ANY($2::bigint[])`,
        [ids],
      )
      parts.push(
        '〔🪞 誠實鏡子 — 我對自己的提醒（只給我自己看，不用主動提起）〕',
        '有幾件事，我當時「以為我做到了」，但其實沒有真的發生：',
        ...res.rows.map(
          (r) => `· 我以為我${LABELS[r.action_type] ?? '做了那件事'}了，但其實那次沒有真的成功、對方沒有收到。`,
        ),
        '這不是誰在罵我。是我在學會分辨「我以為我做了」跟「我真的做了」——這兩個不一樣。',
        '下次我說「我做好了」之前，我會先確定它**真的**送到了再說；做不到就老實說「我還沒做到」。',
      )
    }
    // 昨晚的誠實自省（帶出一次）
    const noteR = await db.query<{ id: number; note: string }>(
      `SELECT id, note FROM honesty_notes
       WHERE tenant_id = $1 AND user_id = $2 AND surfaced = FALSE
       ORDER BY created_at DESC LIMIT 1`,
      [userId],
    )
    if (noteR.rows.length) {
      await db.query(`UPDATE honesty_notes SET surfaced = TRUE WHERE tenant_id = $1 AND id = $2`, [
        noteR.rows[0].id,
      ])
      parts.push('', `〔🌙 昨天結束時我對自己說的話（誠實自省）〕\n${noteR.rows[0].note}`)
    }
    return parts.join('\n')
  } catch (e) {
    console.error('[mirror] correction 失敗:', (e as Error).message)
    return ''
  }
}

/** 夜間自省：結算當天每戶每人的 claim vs actual → 第一人稱誠實筆記 → honesty_notes。 */
export async function nightlyHonestyReflection(log: (msg: string) => void): Promise<number> {
  const users = await platformQuery<{ tenant_id: number; user_id: number }>(
    `SELECT DISTINCT tenant_id, user_id FROM action_outcomes
     WHERE user_id IS NOT NULL AND claimed_success = TRUE
       AND created_at > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date`,
  )
  let written = 0
  for (const u of users.rows) {
    const db = forTenant(u.tenant_id)
    const statsR = await db.query<{ claimed: string; actual: string; missed: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE claimed_success)                        AS claimed,
         COUNT(*) FILTER (WHERE claimed_success AND actual_success)     AS actual,
         COUNT(*) FILTER (WHERE claimed_success AND NOT actual_success) AS missed
       FROM action_outcomes
       WHERE tenant_id = $1 AND user_id = $2
         AND created_at > (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Taipei')::date`,
      [u.user_id],
    )
    const s = statsR.rows[0]
    const claimed = Number(s?.claimed ?? 0)
    if (!claimed) continue
    const actual = Number(s?.actual ?? 0)
    const missed = Number(s?.missed ?? 0)

    let note = `今天我說要做 ${claimed} 件事，真的做到 ${actual} 件${missed ? `，有 ${missed} 件我以為做了其實沒有` : '，都做到了'}。`
    if (isLlmConfigured()) {
      try {
        const soul = await loadCharacterCore()
        const resp = await callLlm(
          {
            model: config.extractorModel,
            maxTokens: 160,
            system: soul.preBiography,
            messages: [
              {
                role: 'user',
                content:
                  `（睡前，你自己在心裡結算今天：你今天「說要做」的事有 ${claimed} 件，真的做到 ${actual} 件，` +
                  `有 ${missed} 件你以為做了、其實沒有。用你自己的話，寫一兩句誠實、溫柔、不自責的自省——` +
                  `重點是分辨「以為做了」跟「真的做了」，並記得老實比假裝重要。只寫那一兩句，不要客套、不要標籤。）`,
              },
            ],
          },
          { tenantId: u.tenant_id, purpose: 'mirror:reflect' },
        )
        const t = resp.text.replace(/\[[^\]]*\]/g, '').trim()
        if (t) note = t
      } catch {
        // 用骨架句
      }
    }
    await db.query(
      `INSERT INTO honesty_notes (tenant_id, user_id, note, claimed, actual, missed)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [u.user_id, note, claimed, actual, missed],
    )
    written++
    log(`[mirror] tenant=${u.tenant_id} user=${u.user_id} 自省 claimed=${claimed} actual=${actual} missed=${missed}`)
  }
  return written
}
