import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'
import { createHmac } from 'node:crypto'

const replyMessages = vi.fn(async () => {})
const handleAieqText = vi.fn(async (input: { text: string }) =>
  /^開始 AIEQ$/.test(input.text) ? [{ type: 'flex', altText: 'q1', contents: {} }] : null)
const handleAieqPostback = vi.fn(async () => [{ type: 'text', text: 'next' }])
const upsertUser = vi.fn(async () => ({ id: 7, display_name: '測試' }))

vi.mock('../src/modules/line.js', () => ({
  verifyLineSignature: (raw: Buffer, signature?: string) =>
    signature === createHmac('sha256', 'test-secret').update(raw).digest('base64'),
  replyMessages: (...args: unknown[]) => replyMessages(...(args as [])),
  getLineProfile: async () => ({ displayName: '測試', pictureUrl: null }),
}))
vi.mock('../src/modules/tenancy.js', () => ({ upsertUser: (...args: unknown[]) => upsertUser(...(args as [])) }))
vi.mock('../src/modules/aieq/channel.js', () => ({
  handleAieqText: (input: { text: string }) => handleAieqText(input),
  handleAieqPostback: (...args: unknown[]) => handleAieqPostback(...(args as [])),
}))
// The durable inbox is exercised by the platform's own tests; here events go straight to the handler.
vi.mock('../src/modules/webhookQueue.js', () => {
  const queue: unknown[] = []
  return {
    enqueueWebhookEvents: async (events: unknown[]) => { queue.push(...events); return events.length },
    drainWebhookEvents: async (handler: (event: unknown) => Promise<void>) => {
      let processed = 0
      while (queue.length) { await handler(queue.shift()); processed++ }
      return { processed, failed: 0 }
    },
  }
})

const { aieqWebhookRoutes, handleAieqLineEvent, pointerMessage } = await import('../src/routes/aieqWebhook.js')

async function post(events: unknown[], sign = true) {
  const app = Fastify()
  await app.register(aieqWebhookRoutes, { prefix: '/api/webhook' })
  const raw = Buffer.from(JSON.stringify({ events }))
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (sign) headers['x-line-signature'] = createHmac('sha256', 'test-secret').update(raw).digest('base64')
  const res = await app.inject({ method: 'POST', url: '/api/webhook/line', payload: raw, headers })
  await new Promise((r) => setTimeout(r, 20))
  await app.close()
  return res
}

const text = (t: string) => ({ type: 'message', replyToken: 'rt', webhookEventId: 'e1', source: { userId: 'U1', type: 'user' }, message: { id: 'm1', type: 'text', text: t } })

describe('AI Personality standalone LINE webhook', () => {
  beforeEach(() => { replyMessages.mockClear(); handleAieqText.mockClear(); handleAieqPostback.mockClear(); upsertUser.mockClear() })

  it('rejects requests without a valid LINE signature', async () => {
    expect((await post([text('開始 AIEQ')], false)).statusCode).toBe(403)
    expect(replyMessages).not.toHaveBeenCalled()
  })

  it('answers quiz commands with the quiz card', async () => {
    const res = await post([text('開始 AIEQ')])
    expect(res.statusCode).toBe(200)
    expect(replyMessages).toHaveBeenCalledWith('rt', [{ type: 'flex', altText: 'q1', contents: {} }])
  })

  it('points any other text at the LIFF instead of running Mantou onboarding', async () => {
    await post([text('你好')])
    expect(replyMessages).toHaveBeenCalledTimes(1)
    const [, messages] = replyMessages.mock.calls[0] as unknown as [string, Array<{ text: string }>]
    expect(messages[0].text).toContain('AI 人格誌')
    expect(messages[0].text).toContain(pointerMessage().text.split('\n')[1])
  })

  it('ignores media, follows and empty messages', async () => {
    await post([
      { type: 'message', replyToken: 'rt', source: { userId: 'U1' }, message: { id: 'm2', type: 'image' } },
      { type: 'follow', replyToken: 'rt', source: { userId: 'U1' } },
      text('   '),
    ])
    expect(replyMessages).not.toHaveBeenCalled()
    expect(upsertUser).not.toHaveBeenCalled()
  })

  it('routes card taps to the quiz postback handler', async () => {
    const messages = await handleAieqLineEvent({ type: 'postback', replyToken: 'rt', source: { userId: 'U1' }, postback: { data: 'action=aieq_answer' } })
    expect(handleAieqPostback).toHaveBeenCalledWith({ userId: 7, data: 'action=aieq_answer', eventId: 'line:U1:action=aieq_answer' })
    expect(messages).toEqual([{ type: 'text', text: 'next' }])
  })
})
