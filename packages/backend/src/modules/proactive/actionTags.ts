import { forTenant } from '../../db/tenantDb.js'
import {
  parseRemindTag,
  parsePromiseUpdateTag,
  parsePromiseCancelTag,
  stripActionTags,
  createPromise,
  updatePromiseByMatch,
  cancelPromisesByMatch,
  extractReminderFromText,
  taipeiIsoToUtc,
} from './promises.js'
import { recordActionOutcome } from '../mirror.js'
import { parseNoteTag, stripNoteTag, saveReadingNote } from './reading.js'
import {
  parseUpgradeRequestTag,
  recordUpgradeRequest,
  stripUpgradeRequestTags,
} from '../upgrades.js'

/**
 * 回覆的「動作標籤」執行端（病根紀律：標籤才算做了，嘴巴說不算）。
 * 解析她回覆裡的 [REMIND]/[PROMISE_UPDATE]/[PROMISE_CANCEL]/[SCHEDULE]，
 * 真的落 DB，再把標籤從顯示文字剝掉。
 */

export interface ActionTagResult {
  cleanText: string
  promiseCreated: boolean
  promiseUpdated: number
  promiseCancelled: number
  scheduleCreated: boolean
  noteSaved: boolean
  upgradeRequestId: number | null
}

/** [SCHEDULE title="..." start="YYYY-MM-DDTHH:mm" end="..." location="..." people="..." repeat="daily|weekly|monthly|yearly" count="N"] */
export function parseScheduleTag(text: string): {
  title: string
  startIso: string
  endIso?: string
  location?: string
  people?: string
  repeat?: 'daily' | 'weekly' | 'monthly' | 'yearly'
  count?: number
} | null {
  const m = text.match(/\[SCHEDULE\b([^\]]*)\]/i)
  if (!m) return null
  const a = m[1]
  const g = (key: string) => (a.match(new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] || '').trim()
  const title = g('title')
  const startIso = g('start')
  if (!title || !startIso) return null
  const repeat = g('repeat').toLowerCase()
  return {
    title,
    startIso,
    endIso: g('end') || undefined,
    location: g('location') || undefined,
    people: g('people') || undefined,
    repeat: ['daily', 'weekly', 'monthly', 'yearly'].includes(repeat)
      ? (repeat as 'daily' | 'weekly' | 'monthly' | 'yearly')
      : undefined,
    count: g('count') ? Number(g('count')) || undefined : undefined,
  }
}

export async function applyActionTags(
  tenantId: number,
  userId: number,
  reply: string,
  userMessage: string,
  canShapeSoul = false,
): Promise<ActionTagResult> {
  const result: ActionTagResult = {
    cleanText: stripUpgradeRequestTags(stripActionTags(stripNoteTag(reply))),
    promiseCreated: false,
    promiseUpdated: 0,
    promiseCancelled: 0,
    scheduleCreated: false,
    noteSaved: false,
    upgradeRequestId: null,
  }

  const upgrade = parseUpgradeRequestTag(reply)
  if (canShapeSoul && upgrade) {
    result.upgradeRequestId = await recordUpgradeRequest({
      tenantId,
      userId,
      title: upgrade.title,
      details: upgrade.details,
      source: 'line_action_tag',
    })
  }

  // 共讀筆記：[NOTE]...[/NOTE] → 入庫＋進度推進（她嘴上說「記下來囉」不算，標籤才算）
  const note = parseNoteTag(reply)
  if (note) {
    result.noteSaved = await saveReadingNote(tenantId, note)
  }

  // 約定：建立（她放了標籤=宣稱做了；真相=DB 是否真的建立 → 誠實鏡子落帳）
  const remind = parseRemindTag(reply)
  if (remind) {
    result.promiseCreated = await createPromise(tenantId, userId, remind, userMessage.slice(0, 200))
    void recordActionOutcome({
      tenantId, userId, actionType: 'promise_created',
      claimedSuccess: true, actualSuccess: result.promiseCreated,
      evidence: remind.content.slice(0, 100),
    })
  }
  // 約定：修改／取消
  const upd = parsePromiseUpdateTag(reply)
  if (upd) {
    result.promiseUpdated = await updatePromiseByMatch(tenantId, userId, upd.match, {
      fireHour: upd.fireHour,
      fireMinute: upd.fireMinute,
      content: upd.content,
    })
  }
  const cancel = parsePromiseCancelTag(reply)
  if (cancel) {
    result.promiseCancelled = await cancelPromisesByMatch(tenantId, userId, cancel.match)
  }

  // 行事曆（v1：落 scheduled_events；gcal 連結整合後補）
  const sched = parseScheduleTag(reply)
  if (sched) {
    const startAt = taipeiIsoToUtc(sched.startIso)
    if (startAt) {
      const db = forTenant(tenantId)
      await db.query(
        `INSERT INTO scheduled_events (tenant_id, user_id, title, start_at, end_at, location, people, repeat, repeat_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          userId,
          sched.title,
          startAt,
          sched.endIso ? taipeiIsoToUtc(sched.endIso) : null,
          sched.location ?? null,
          sched.people ?? null,
          sched.repeat ?? null,
          sched.count ?? null,
        ],
      )
      result.scheduleCreated = true
    }
    void recordActionOutcome({
      tenantId, userId, actionType: 'schedule_created',
      claimedSuccess: true, actualSuccess: result.scheduleCreated,
      evidence: sched.title.slice(0, 100),
    })
  }

  return result
}

/**
 * 🛡️ 安全網（fire-and-forget）：標籤層什麼都沒建、但對話看起來有約定 → LLM 補抽。
 * 只在確定性層零命中時才跑（省錢 + 不重複建）。
 */
export async function promiseSafetyNet(
  tenantId: number,
  userId: number,
  userMessage: string,
  reply: string,
  tagResult: ActionTagResult,
): Promise<boolean> {
  if (tagResult.promiseCreated || tagResult.promiseUpdated || tagResult.promiseCancelled) return false
  const spec = await extractReminderFromText(tenantId, userMessage, reply)
  if (!spec) return false
  return createPromise(tenantId, userId, spec, userMessage.slice(0, 200))
}
