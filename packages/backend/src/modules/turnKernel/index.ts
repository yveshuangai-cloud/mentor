import { createHash, randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import { platformQuery } from '../../db/index.js'

export const TURN_EVENT_VERSION = '1.0' as const

export type TurnChannel =
  | 'line_text'
  | 'line_audio'
  | 'line_image'
  | 'line_document'
  | 'websocket_voice'
  | 'livekit_voice'

export type TurnDirection = 'inbound' | 'internal' | 'outbound'

export interface TurnEvent {
  version: typeof TURN_EVENT_VERSION
  eventId: string
  turnId: string
  tenantId: number
  userId: number
  conversationId?: number | null
  channel: TurnChannel
  direction: TurnDirection
  eventType: string
  occurredAt: string
  elapsedMs: number
  payload: Record<string, unknown>
}

export interface ContextBlockObservation {
  name: string
  content: string
  loadMs?: number
  selected?: boolean
  /** False for diagnostic child blocks already included in a counted roll-up block. */
  counted?: boolean
}

export interface ModelObservation {
  model: string
  reply: string
  tokensInput: number
  tokensOutput: number
  requestCount: number
  stopReason?: string | null
  webSearchUsed: boolean
}

export interface TurnKernel {
  readonly turnId: string
  readonly tenantId: number
  readonly userId: number
  readonly channel: TurnChannel
  mark(eventType: string, payload?: Record<string, unknown>): void
  observeContext(blocks: ContextBlockObservation[]): void
  observeModel(observation: ModelObservation): void
  finish(params: { conversationId?: number | null; deliveredText: string; metadata?: Record<string, unknown> }): void
  fail(error: unknown, stage?: string): void
}

interface TurnEventSink {
  write(events: TurnEvent[]): Promise<void>
}

const postgresSink: TurnEventSink = {
  async write(events) {
    if (!events.length) return
    const values: unknown[] = []
    const rows = events.map((event, rowIndex) => {
      const offset = rowIndex * 11
      values.push(
        event.eventId,
        event.turnId,
        event.tenantId,
        event.userId,
        event.conversationId ?? null,
        event.channel,
        event.direction,
        event.eventType,
        event.occurredAt,
        event.elapsedMs,
        JSON.stringify(event.payload),
      )
      return `(${Array.from({ length: 11 }, (_, index) => `$${offset + index + 1}`).join(', ')})`
    })
    await platformQuery(
      `INSERT INTO turn_events
         (event_id, turn_id, tenant_id, user_id, conversation_id, channel, direction,
          event_type, occurred_at, elapsed_ms, payload)
       VALUES ${rows.join(', ')}`,
      values,
    )
  },
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.max(1, Math.ceil(Buffer.byteLength(text, 'utf8') / 4))
}

function surfaceTerms(text: string): Set<string> {
  const normalized = text.toLowerCase().replace(/https?:\/\/\S+/g, ' ')
  const terms = new Set(normalized.match(/[a-z0-9][a-z0-9_-]{2,}|[\p{Script=Han}]{2,}/gu) ?? [])
  for (const run of normalized.match(/[\p{Script=Han}]{3,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2))
  }
  return terms
}

export function contextUseEvidence(block: ContextBlockObservation, reply: string): {
  method: 'citation_or_surface_overlap'
  observed: boolean
  score: number
  citationHits: number
} {
  const replyUrls = reply.match(/https?:\/\/\S+/g) ?? []
  const citationHits = replyUrls.filter((url) => block.content.includes(url.replace(/[),.。]+$/, ''))).length
  const replyTerms = surfaceTerms(reply)
  const blockTerms = surfaceTerms(block.content)
  let overlap = 0
  for (const term of replyTerms) if (blockTerms.has(term)) overlap += 1
  const score = replyTerms.size ? Number((overlap / replyTerms.size).toFixed(4)) : 0
  return {
    method: 'citation_or_surface_overlap',
    observed: citationHits > 0 || score >= 0.08,
    score,
    citationHits,
  }
}

export interface CreateShadowTurnInput {
  tenantId: number
  userId: number
  channel: TurnChannel
  inputText: string
  contentKind?: 'text' | 'audio' | 'image' | 'document'
  metadata?: Record<string, unknown>
}

export function createShadowTurn(input: CreateShadowTurnInput, sink: TurnEventSink = postgresSink): TurnKernel {
  const turnId = randomUUID()
  const startedAt = Date.now()
  let contextBlocks: ContextBlockObservation[] = []
  const pendingEvents: TurnEvent[] = []
  let flushed = false

  const emit = (
    eventType: string,
    direction: TurnDirection,
    payload: Record<string, unknown> = {},
    conversationId?: number | null,
  ) => {
    if (!config.turnShadowEnabled) return
    const event: TurnEvent = {
      version: TURN_EVENT_VERSION,
      eventId: randomUUID(),
      turnId,
      tenantId: input.tenantId,
      userId: input.userId,
      conversationId,
      channel: input.channel,
      direction,
      eventType,
      occurredAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
      payload,
    }
    pendingEvents.push(event)
  }

  const flush = () => {
    if (flushed || !config.turnShadowEnabled || !pendingEvents.length) return
    flushed = true
    void sink.write(pendingEvents).catch((error) => {
      console.warn('[turn-shadow] write failed', {
        turnId,
        eventCount: pendingEvents.length,
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  emit('turn.received', 'inbound', {
    content: {
      kind: input.contentKind ?? 'text',
      sha256: hashText(input.inputText),
      charCount: input.inputText.length,
      estimatedTokens: estimateTokens(input.inputText),
    },
    ...input.metadata,
  })

  return {
    turnId,
    tenantId: input.tenantId,
    userId: input.userId,
    channel: input.channel,
    mark(eventType, payload = {}) {
      emit(eventType, 'internal', payload)
    },
    observeContext(blocks) {
      contextBlocks = blocks
      emit('context.compiled', 'internal', {
        totalBlocks: blocks.length,
        selectedBlocks: blocks.filter((block) => block.selected !== false).length,
        totalChars: blocks
          .filter((block) => block.selected !== false && block.counted !== false)
          .reduce((sum, block) => sum + block.content.length, 0),
        estimatedTokens: blocks
          .filter((block) => block.selected !== false && block.counted !== false)
          .reduce((sum, block) => sum + estimateTokens(block.content), 0),
        blocks: blocks.map((block) => ({
          name: block.name,
          selected: block.selected !== false,
          counted: block.counted !== false,
          sha256: hashText(block.content),
          charCount: block.content.length,
          estimatedTokens: estimateTokens(block.content),
          loadMs: block.loadMs ?? null,
        })),
      })
    },
    observeModel(observation) {
      emit('model.completed', 'internal', {
        model: observation.model,
        tokensInput: observation.tokensInput,
        tokensOutput: observation.tokensOutput,
        requestCount: observation.requestCount,
        stopReason: observation.stopReason ?? null,
        webSearchUsed: observation.webSearchUsed,
        reply: {
          sha256: hashText(observation.reply),
          charCount: observation.reply.length,
        },
        contextUseEvidence: contextBlocks.map((block) => ({
          name: block.name,
          ...contextUseEvidence(block, observation.reply),
        })),
        evidenceLimitation: 'Post-hoc citation and surface-overlap proxy; not model attention attribution.',
      })
    },
    finish({ conversationId = null, deliveredText, metadata = {} }) {
      emit('turn.delivered', 'outbound', {
        response: {
          sha256: hashText(deliveredText),
          charCount: deliveredText.length,
          estimatedTokens: estimateTokens(deliveredText),
        },
        ...metadata,
      }, conversationId)
      flush()
    },
    fail(error, stage = 'unknown') {
      emit('turn.failed', 'internal', {
        stage,
        error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500),
      })
      flush()
    },
  }
}
