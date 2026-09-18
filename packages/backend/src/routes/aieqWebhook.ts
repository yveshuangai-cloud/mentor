import type { FastifyInstance } from 'fastify'
import { config } from '../config.js'
import { getLineProfile, replyMessages, verifyLineSignature, type LineMessage } from '../modules/line.js'
import { upsertUser } from '../modules/tenancy.js'
import { drainWebhookEvents, enqueueWebhookEvents } from '../modules/webhookQueue.js'
import { handleAieqPostback, handleAieqText } from '../modules/aieq/channel.js'

/**
 * LINE webhook for an AI Personality-only Official Account.
 *
 * This deployment is not a Mantou tenant: there is no onboarding ritual, no LLM turn and no
 * media handling. It answers quiz commands and in-chat answers, points everything else at the
 * LIFF, and ignores what it does not understand. Mounted instead of the Mantou webhook when
 * AIEQ_ONLY_WEBHOOK is set, at the same path, so the LINE console needs no change.
 */
interface LineEvent {
  webhookEventId?: string
  type: string
  replyToken?: string
  source?: { userId?: string; type?: string }
  message?: { id?: string; type?: string; text?: string }
  postback?: { data?: string }
}

export function liffEntryUrl(): string {
  return config.liffId === 'not-configured' ? `${config.publicBaseUrl}/aieq` : `https://liff.line.me/${config.liffId}`
}

export function pointerMessage(): LineMessage {
  return {
    type: 'text',
    text: `這裡是 AI 人格誌。點下方選單的「開始探索」就能開始，或輸入「開始 AIEQ」直接在聊天室作答。\n${liffEntryUrl()}`,
  }
}

export async function handleAieqLineEvent(event: LineEvent): Promise<LineMessage[] | null> {
  const lineUserId = event.source?.userId
  const replyToken = event.replyToken
  if (!lineUserId || !replyToken) return null

  if (event.type === 'postback') {
    const data = event.postback?.data
    if (!data) return null
    const user = await upsertUser(lineUserId, await getLineProfile(lineUserId))
    return handleAieqPostback({ userId: user.id, data, eventId: `line:${event.webhookEventId ?? `${lineUserId}:${data}`}` })
  }

  if (event.type !== 'message' || event.message?.type !== 'text') return null
  const text = (event.message.text ?? '').trim()
  if (!text) return null
  const user = await upsertUser(lineUserId, await getLineProfile(lineUserId))
  const messages = await handleAieqText({
    userId: user.id,
    text,
    eventId: `line:${event.webhookEventId ?? event.message.id ?? `${lineUserId}:${Date.now()}`}`,
  })
  return messages ?? [pointerMessage()]
}

export async function processAieqWebhookEvents(app: FastifyInstance, limit = 20): Promise<{ processed: number; failed: number }> {
  return drainWebhookEvents<LineEvent>(
    async (event) => {
      const messages = await handleAieqLineEvent(event)
      if (messages && event.replyToken) await replyMessages(event.replyToken, messages)
    },
    (message) => app.log.warn(message),
    limit,
  )
}

export async function aieqWebhookRoutes(app: FastifyInstance): Promise<void> {
  // Keep the raw body: the LINE signature is computed over the exact bytes.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.post('/line', async (req, reply) => {
    const raw = req.body as Buffer
    const signature = req.headers['x-line-signature'] as string | undefined
    if (!verifyLineSignature(raw, signature)) return reply.code(403).send({ error: 'bad signature' })
    const payload = JSON.parse(raw.toString('utf8')) as { events?: LineEvent[] }
    await enqueueWebhookEvents(payload.events ?? [])
    reply.send({ status: 'ok' })
    void processAieqWebhookEvents(app).catch((err) => app.log.error({ err }, 'aieq webhook drain error'))
  })
}
