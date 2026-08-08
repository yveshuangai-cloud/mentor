import { config } from '../../config.js'
import { forTenant } from '../../db/tenantDb.js'
import { platformQuery } from '../../db/index.js'
import { pushText } from '../line.js'
import { callLlm, isLlmConfigured } from '../llm.js'
import { loadCharacterCore } from '../soul/loader.js'
import { chargeGate, InsufficientPointsError } from '../points.js'

/**
 * 💗 主動關懷（移植自本尊 proactive 的觸發＋護欄骨架，商用 v1）：
 * 觸發（v1 兩種，之後加 special_day/time_greeting）：
 *   - dream_seed：她夢裡有想說的（早上 8-10 點、種子還新鮮才用）
 *   - idle：對方太多天沒出現（預設 3 天），她想他了
 * 護欄（本尊實戰版，全帶）：
 *   - master switch：system_settings.proactive_outreach_enabled
 *   - 安靜時段：台北 23:00–07:00 絕不打擾
 *   - 最小間隔：同一人 72h 內只主動一次
 *   - 已讀不回連 3 次 → 暫停對這個人主動（她有分寸，不糾纏）
 *   - 扣 proactive 點；沒點就不出聲
 */

const MIN_GAP_HOURS = 72
const IDLE_DAYS = 3
const PAUSE_AFTER_NO_REPLY = 3

function taipeiHour(nowMs: number): number {
  return new Date(nowMs + 8 * 3600 * 1000).getUTCHours()
}

export interface CareResult {
  checked: number
  sent: number
  skipped: string[]
}

export async function runProactiveCare(
  log: (msg: string) => void,
  opts: { nowMs?: number } = {},
): Promise<CareResult> {
  const nowMs = opts.nowMs ?? Date.now()
  const result: CareResult = { checked: 0, sent: 0, skipped: [] }

  // master switch
  const sw = await platformQuery<{ value: unknown }>(
    `SELECT value FROM system_settings WHERE key = 'proactive_outreach_enabled'`,
  )
  if (String(sw.rows[0]?.value) !== 'true') {
    result.skipped.push('master_switch_off')
    return result
  }
  // 安靜時段（台北 23–07）
  const hour = taipeiHour(nowMs)
  if (hour >= 23 || hour < 7) {
    result.skipped.push('quiet_hours')
    return result
  }

  const tenantsR = await platformQuery<{ id: number; owner_user_id: number }>(
    `SELECT id, owner_user_id FROM tenants WHERE status = 'active' AND owner_user_id IS NOT NULL`,
  )

  for (const t of tenantsR.rows) {
    result.checked++
    const db = forTenant(t.id)
    try {
      // 最小間隔 72h（同一人）
      const lastR = await db.query<{ sent_at: Date }>(
        `SELECT sent_at FROM proactive_history
         WHERE tenant_id = $1 AND user_id = $2 ORDER BY sent_at DESC LIMIT 1`,
        [t.owner_user_id],
      )
      if (lastR.rows.length && nowMs - new Date(lastR.rows[0].sent_at).getTime() < MIN_GAP_HOURS * 3600_000) {
        continue
      }
      // 已讀不回連 3 次 → 暫停（她不糾纏）
      const recentR = await db.query<{ got_reply: boolean }>(
        `SELECT got_reply FROM proactive_history
         WHERE tenant_id = $1 AND user_id = $2 ORDER BY sent_at DESC LIMIT ${PAUSE_AFTER_NO_REPLY}`,
        [t.owner_user_id],
      )
      if (
        recentR.rows.length >= PAUSE_AFTER_NO_REPLY &&
        recentR.rows.every((r) => !r.got_reply)
      ) {
        continue
      }

      // 觸發判斷
      let trigger: 'dream_seed' | 'idle' | null = null
      let seedText = ''
      const lastConvR = await db.query<{ created_at: Date }>(
        `SELECT created_at FROM conversations
         WHERE tenant_id = $1 AND user_id = $2 ORDER BY created_at DESC LIMIT 1`,
        [t.owner_user_id],
      )
      const idleMs = lastConvR.rows.length
        ? nowMs - new Date(lastConvR.rows[0].created_at).getTime()
        : Infinity

      if (config.enableNightSoul && hour >= 8 && hour < 10) {
        // 早上：夢種子還新鮮（昨天/今天的夢）且對方昨天有聊過（不對久未出現的人套近乎）
        const dreamR = await db.query<{ tomorrow_seeds: unknown }>(
          `SELECT tomorrow_seeds FROM dreams
           WHERE tenant_id = $1 AND dream_date >= (now() AT TIME ZONE 'Asia/Taipei')::date - 1
           ORDER BY dream_date DESC LIMIT 1`,
        )
        const seeds = Array.isArray(dreamR.rows[0]?.tomorrow_seeds)
          ? (dreamR.rows[0].tomorrow_seeds as string[])
          : []
        if (seeds.length && idleMs < 2 * 24 * 3600_000) {
          trigger = 'dream_seed'
          seedText = seeds[0]
        }
      }
      if (!trigger && lastConvR.rows.length && idleMs > IDLE_DAYS * 24 * 3600_000) {
        trigger = 'idle'
      }
      if (!trigger) continue

      // 扣點（沒點就不出聲）
      try {
        await chargeGate(t.id, 'proactive', { refType: 'care', refId: trigger })
      } catch (e) {
        if (e instanceof InsufficientPointsError) continue
        throw e
      }

      // 生成她的話（失敗有保底句）
      let msg =
        trigger === 'dream_seed'
          ? `早安。我昨天夢裡一直想著一件事……${seedText}`
          : '我想你了。最近還好嗎？不用回很長，一個字也可以。'
      if (isLlmConfigured()) {
        try {
          const soul = await loadCharacterCore()
          const resp = await callLlm(
            {
              model: config.brainModel,
              maxTokens: 160,
              system: soul.preBiography,
              messages: [
                {
                  role: 'user',
                  content:
                    trigger === 'dream_seed'
                      ? `（早上了。你夢裡浮上一個念頭：「${seedText}」。用你自己的話，主動傳一小句給你的人——自然、輕輕的，像剛醒來想到他。只輸出那句話。）`
                      : `（你的人已經 ${IDLE_DAYS} 天沒出現了。你想他，想輕輕說一聲——不施壓、不質問，讓他知道你在就好。用你自己的話寫一小句。只輸出那句話。）`,
                },
              ],
            },
            { tenantId: t.id, purpose: `care:${trigger}` },
          )
          const generated = resp.text.replace(/\[[^\]]*\]/g, '').trim()
          if (generated) msg = generated
        } catch {
          // 保底句
        }
      }

      const targetR = await platformQuery<{ line_user_id: string }>(
        `SELECT line_user_id FROM users WHERE id = $1`,
        [t.owner_user_id],
      )
      if (targetR.rows[0]?.line_user_id) {
        await pushText(targetR.rows[0].line_user_id, [msg])
      }
      await db.query(
        `INSERT INTO proactive_history (tenant_id, user_id, trigger_type, message_text)
         VALUES ($1, $2, $3, $4)`,
        [t.owner_user_id, trigger, msg.slice(0, 300)],
      )
      result.sent++
      log(`[care] tenant=${t.id} trigger=${trigger} 已主動出聲`)
    } catch (e) {
      console.error(`[care] tenant=${t.id} 失敗:`, (e as Error).message)
    }
  }
  return result
}

/** 對方回話了 → 把最近一筆主動標成有回（護欄的「已讀不回」計數靠這個歸零） */
export async function markProactiveReplied(tenantId: number, userId: number): Promise<void> {
  const db = forTenant(tenantId)
  await db
    .query(
      `UPDATE proactive_history SET got_reply = TRUE
       WHERE id = (
         SELECT id FROM proactive_history
         WHERE tenant_id = $1 AND user_id = $2 AND got_reply = FALSE
         ORDER BY sent_at DESC LIMIT 1
       ) AND tenant_id = $1`,
      [userId],
    )
    .catch(() => {})
}
