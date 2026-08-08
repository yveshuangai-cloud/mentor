import { createHash } from 'node:crypto'
import { platformQuery, withTransaction } from '../db/index.js'

interface QueuedEvent<T> {
  event_id: string
  payload: T
  attempts: number
}

function durableEventId(event: unknown): { eventId: string; messageId: string | null } {
  const value = event as { webhookEventId?: string; message?: { id?: string } }
  const messageId = value.message?.id ?? null
  if (value.webhookEventId) return { eventId: `line:${value.webhookEventId}`, messageId }
  if (messageId) return { eventId: `message:${messageId}`, messageId }
  const digest = createHash('sha256').update(JSON.stringify(event)).digest('hex')
  return { eventId: `sha256:${digest}`, messageId: null }
}

/** 驗簽成功後先落庫；event_id/message_id 的唯一索引負責跨實例、跨重啟去重。 */
export async function enqueueWebhookEvents(events: unknown[]): Promise<number> {
  let inserted = 0
  for (const event of events) {
    const { eventId, messageId } = durableEventId(event)
    const result = await platformQuery(
      `INSERT INTO line_webhook_events (event_id, message_id, payload)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [eventId, messageId, JSON.stringify(event)],
    )
    inserted += result.rowCount ?? 0
  }
  return inserted
}

async function claimNext<T>(): Promise<QueuedEvent<T> | null> {
  return withTransaction(async (client) => {
    const result = await client.query<QueuedEvent<T>>(
      `WITH candidate AS (
         SELECT event_id FROM line_webhook_events
         WHERE (
           status IN ('pending','retry') AND next_attempt_at <= now()
         ) OR (
           status = 'processing' AND locked_at < now() - interval '5 minutes'
         )
         ORDER BY created_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE line_webhook_events e
       SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
       FROM candidate c
       WHERE e.event_id = c.event_id
       RETURNING e.event_id, e.payload, e.attempts`,
    )
    return result.rows[0] ?? null
  })
}

async function markProcessed(eventId: string): Promise<void> {
  await platformQuery(
    `UPDATE line_webhook_events
     SET status = 'processed', processed_at = now(), locked_at = NULL,
         last_error = NULL, updated_at = now()
     WHERE event_id = $1`,
    [eventId],
  )
}

async function markFailed(eventId: string, attempts: number, err: unknown): Promise<void> {
  const dead = attempts >= 8
  const retrySeconds = Math.min(300, 2 ** Math.min(attempts, 8))
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  await platformQuery(
    `UPDATE line_webhook_events
     SET status = $2, next_attempt_at = now() + ($3 || ' seconds')::interval,
         locked_at = NULL, last_error = $4, updated_at = now()
     WHERE event_id = $1`,
    [eventId, dead ? 'dead' : 'retry', String(retrySeconds), message.slice(0, 2000)],
  )
}

export interface DrainResult {
  processed: number
  failed: number
}

/**
 * 可由 webhook 即時 kick，也可由 Cloud Scheduler 重跑。
 * claim 使用 SKIP LOCKED，多個 Cloud Run instance 不會同時取得同一事件。
 */
export async function drainWebhookEvents<T>(
  processor: (payload: T) => Promise<void>,
  log: (message: string) => void,
  limit = 20,
): Promise<DrainResult> {
  let processed = 0
  let failed = 0
  for (let i = 0; i < limit; i++) {
    const event = await claimNext<T>()
    if (!event) break
    try {
      await processor(event.payload)
      await markProcessed(event.event_id)
      processed++
    } catch (err) {
      await markFailed(event.event_id, event.attempts, err)
      failed++
      log(`webhook retry queued: event=${event.event_id} attempt=${event.attempts}`)
    }
  }
  return { processed, failed }
}
