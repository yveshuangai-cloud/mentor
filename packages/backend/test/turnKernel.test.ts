import { describe, expect, it } from 'vitest'
import {
  contextUseEvidence,
  createShadowTurn,
  estimateTokens,
  type TurnEvent,
} from '../src/modules/turnKernel/index.js'
import {
  buildAnonymizedReplay,
  directIdentifierLeaks,
  redactSensitiveText,
  type ReplaySourceConversation,
} from '../src/modules/turnKernel/replay.js'

describe('Turn Kernel shadow events', () => {
  it('records a unified, content-minimized event sequence without changing a reply', () => {
    const events: TurnEvent[] = []
    const turn = createShadowTurn({
      tenantId: 1,
      userId: 2,
      channel: 'line_text',
      inputText: '我的私人原文',
    }, {
      async write(batch) {
        events.push(...batch)
      },
    })
    turn.observeContext([{ name: 'memory', content: 'Yves 喜歡有來源的答案', loadMs: 12 }])
    turn.observeModel({
      model: 'test-model',
      reply: '我會附上資料來源。',
      tokensInput: 100,
      tokensOutput: 20,
      requestCount: 1,
      webSearchUsed: false,
    })
    turn.finish({ conversationId: 99, deliveredText: '我會附上資料來源。' })

    expect(events.map((event) => event.eventType)).toEqual([
      'turn.received',
      'context.compiled',
      'model.completed',
      'turn.delivered',
    ])
    expect(new Set(events.map((event) => event.turnId)).size).toBe(1)
    expect(events.at(-1)?.conversationId).toBe(99)
    expect(JSON.stringify(events)).not.toContain('我的私人原文')
  })

  it('labels context use as post-hoc observable evidence', () => {
    const evidence = contextUseEvidence(
      { name: 'source', content: 'MiniMax 官方文件 https://example.com/audio' },
      '資料來源：https://example.com/audio',
    )
    expect(evidence.method).toBe('citation_or_surface_overlap')
    expect(evidence.observed).toBe(true)
    expect(estimateTokens('饅頭')).toBeGreaterThan(0)
  })

  it('keeps shadow persistence failures off the reply path', async () => {
    const turn = createShadowTurn({
      tenantId: 1,
      userId: 2,
      channel: 'line_text',
      inputText: '仍然要正常回答',
    }, {
      async write() {
        throw new Error('shadow database unavailable')
      },
    })
    expect(() => turn.finish({ deliveredText: '正常回答' })).not.toThrow()
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
})

describe('anonymized cross-channel replay', () => {
  const rows: ReplaySourceConversation[] = [
    {
      id: 1001,
      tenant_id: 7,
      user_id: 9,
      message_type: 'text',
      user_message: '寄到 yves@example.com，電話 0912-345-678',
      ai_response: '收到。',
      metadata: null,
      created_at: '2026-08-01T12:00:00Z',
    },
    {
      id: 1002,
      tenant_id: 7,
      user_id: 9,
      message_type: 'voice_call',
      user_message: '電話裡接著談。',
      ai_response: '我記得前面的脈絡。',
      metadata: { transport: 'livekit', sessionId: 'must-not-export' },
      created_at: '2026-08-02T12:00:00Z',
    },
  ]

  it('keeps one pseudonymous actor across text and LiveKit while removing direct identifiers', () => {
    const cases = buildAnonymizedReplay(rows, 'replay-test-secret-32-characters', 10)
    expect(cases).toHaveLength(2)
    expect(cases[0]?.actor).toBe(cases[1]?.actor)
    expect(cases.map((item) => item.channel)).toEqual(['line_text', 'livekit_voice'])
    expect(directIdentifierLeaks(JSON.stringify(cases))).toEqual([])
    expect(JSON.stringify(cases)).not.toContain('must-not-export')
  })

  it('redacts LINE IDs and API-style secrets deterministically', () => {
    const raw = 'U0123456789abcdef0123456789abcdef sk-api-abcdefghijklmnop'
    const first = redactSensitiveText(raw, 'replay-test-secret-32-characters')
    const second = redactSensitiveText(raw, 'replay-test-secret-32-characters')
    expect(first).toBe(second)
    expect(first).not.toContain('U0123456789abcdef0123456789abcdef')
    expect(first).not.toContain('sk-api-abcdefghijklmnop')
  })
})
