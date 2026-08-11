import { createHmac } from 'node:crypto'
import type { TurnChannel } from './index.js'

export interface ReplaySourceConversation {
  id: number
  tenant_id: number
  user_id: number
  message_type: string
  user_message: string | null
  ai_response: string | null
  metadata: Record<string, unknown> | null
  created_at: Date | string
}

export interface AnonymizedReplayCase {
  version: '1.0'
  caseId: string
  actor: string
  channel: TurnChannel
  sequence: number
  dayOffset: number
  userMessage: string
  assistantMessage: string
  assertions: Array<'same_actor_across_channels' | 'non_empty_response' | 'no_direct_identifiers'>
}

function pseudonym(secret: string, kind: string, value: string): string {
  return `${kind}_${createHmac('sha256', secret).update(`${kind}:${value}`).digest('hex').slice(0, 12)}`
}

export function redactSensitiveText(text: string, secret: string): string {
  const replace = (kind: string) => (value: string) => `[${pseudonym(secret, kind, value)}]`
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replace('email'))
    .replace(/\bU[0-9a-f]{32}\b/gi, replace('line_user'))
    .replace(/\b(?:sk-(?:api|ant|proj)?-?|AIza|AQ\.)(?:[A-Za-z0-9_-]{12,})\b/g, replace('secret'))
    .replace(/(?<!\d)(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/g, replace('phone'))
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, replace('ip'))
    .replace(/https?:\/\/[^\s)]+/g, (raw) => {
      try {
        const url = new URL(raw)
        return `${url.origin}${url.pathname}`
      } catch {
        return '[url]'
      }
    })
}

export function replayChannel(row: ReplaySourceConversation): TurnChannel {
  if (row.message_type === 'audio') return 'line_audio'
  if (row.message_type === 'image') return 'line_image'
  if (row.message_type === 'file' || row.message_type === 'document') return 'line_document'
  if (row.message_type === 'voice_call') {
    return row.metadata?.transport === 'livekit' ? 'livekit_voice' : 'websocket_voice'
  }
  return 'line_text'
}

export function buildAnonymizedReplay(
  rows: ReplaySourceConversation[],
  secret: string,
  perChannel = 50,
): AnonymizedReplayCase[] {
  if (secret.length < 16) throw new Error('Replay anonymization secret must contain at least 16 characters')
  const ordered = [...rows].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
  const firstByActor = new Map<string, number>()
  const sequenceByActor = new Map<string, number>()
  const countByChannel = new Map<TurnChannel, number>()
  const result: AnonymizedReplayCase[] = []

  for (const row of ordered) {
    if (!row.user_message || !row.ai_response) continue
    const channel = replayChannel(row)
    const count = countByChannel.get(channel) ?? 0
    if (count >= perChannel) continue
    const actor = pseudonym(secret, 'actor', `${row.tenant_id}:${row.user_id}`)
    const timestamp = new Date(row.created_at).getTime()
    const first = firstByActor.get(actor) ?? timestamp
    firstByActor.set(actor, first)
    const sequence = (sequenceByActor.get(actor) ?? 0) + 1
    sequenceByActor.set(actor, sequence)
    countByChannel.set(channel, count + 1)
    result.push({
      version: '1.0',
      caseId: pseudonym(secret, 'case', String(row.id)),
      actor,
      channel,
      sequence,
      dayOffset: Math.max(0, Math.floor((timestamp - first) / 86_400_000)),
      userMessage: redactSensitiveText(row.user_message, secret),
      assistantMessage: redactSensitiveText(row.ai_response, secret),
      assertions: ['same_actor_across_channels', 'non_empty_response', 'no_direct_identifiers'],
    })
  }
  return result
}

export function directIdentifierLeaks(text: string): string[] {
  const patterns: Array<[string, RegExp]> = [
    ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i],
    ['line_user', /\bU[0-9a-f]{32}\b/i],
    ['api_secret', /\b(?:sk-(?:api|ant|proj)?-?|AIza|AQ\.)(?:[A-Za-z0-9_-]{12,})\b/],
    ['phone', /(?<!\d)(?:\+?886[-\s]?)?0?9\d{2}[-\s]?\d{3}[-\s]?\d{3}(?!\d)/],
  ]
  return patterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name)
}
