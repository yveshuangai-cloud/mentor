import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type WebSocket from 'ws'
import { config } from '../config.js'
import { forTenant } from '../db/tenantDb.js'
import { processMessage } from '../modules/brain.js'
import { sanitizeConversationalText } from '../modules/conversationStyle.js'
import { extractAndLearn } from '../modules/memory/learner.js'
import { chargeGate, InsufficientPointsError } from '../modules/points.js'
import { resolveMembership, upsertUser } from '../modules/tenancy.js'
import { synthesize, voiceConfigured } from '../modules/voice.js'
import { issueVoiceToken, verifyLiffIdToken, verifyVoiceToken } from '../modules/voiceCall/auth.js'
import { DeepgramStream } from '../modules/voiceCall/deepgram.js'
import { VoiceGeneration } from '../modules/voiceCall/generation.js'

type VoiceState = 'listening' | 'hearing' | 'thinking' | 'speaking' | 'interrupting'

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(value))
}

function shortSpokenReply(reply: string): string {
  const clean = sanitizeConversationalText(reply)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\*#`_~-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= 260) return clean
  const window = clean.slice(0, 260)
  const lastStop = Math.max(window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'))
  return (lastStop >= 40 ? window.slice(0, lastStop + 1) : window).trim()
}

export async function voiceCallRoutes(app: FastifyInstance): Promise<void> {
  app.get('/public-config', async () => ({
    liffId: config.liffId === 'not-configured' ? null : config.liffId,
    ready: config.liffId !== 'not-configured'
      && config.lineLoginChannelId !== 'not-configured'
      && config.deepgramApiKey !== 'not-configured'
      && voiceConfigured(),
  }))

  app.post<{ Body: { idToken?: string } }>('/session', async (request, reply) => {
    try {
      const identity = await verifyLiffIdToken(request.body?.idToken ?? '')
      const user = await upsertUser(identity.lineUserId, {
        displayName: identity.displayName,
        pictureUrl: identity.pictureUrl,
      })
      const membership = await resolveMembership(user.id)
      if (!membership || membership.member.status !== 'confirmed' || membership.tenant.status !== 'active') {
        return reply.code(403).send({ error: 'voice_membership_not_active' })
      }
      const sessionId = randomUUID()
      return {
        sessionId,
        token: issueVoiceToken(identity.lineUserId, sessionId),
        websocketPath: '/api/voice-call/ws',
      }
    } catch (error) {
      request.log.warn({ err: error }, 'LIFF voice session authorization failed')
      return reply.code(401).send({ error: 'voice_session_unauthorized' })
    }
  })

  app.get('/ws', { websocket: true }, async (socket, request) => {
    let deepgram: DeepgramStream | null = null
    let sessionStarted = false
    let sessionStarting = false
    let closed = false
    let finalParts: string[] = []
    let activeTurns = 0
    const generations = new VoiceGeneration()
    const pendingMessages: Array<{ raw: Buffer; isBinary: boolean }> = []
    let handleMessage: ((raw: Buffer, isBinary: boolean) => void) | null = null

    // Attach synchronously: a browser may send call:start immediately after open,
    // while LINE identity and membership are still being resolved.
    socket.on('message', (raw, isBinary) => {
      const buffered = Buffer.from(raw as Buffer)
      if (handleMessage) handleMessage(buffered, isBinary)
      else pendingMessages.push({ raw: buffered, isBinary })
    })

    try {
      const token = (request.query as { token?: string }).token ?? ''
      const tokenPayload = verifyVoiceToken(token)
      const user = await upsertUser(tokenPayload.sub, {})
      const membership = await resolveMembership(user.id)
      if (!membership || membership.member.status !== 'confirmed' || membership.tenant.status !== 'active') {
        throw new Error('voice_membership_not_active')
      }
      const { tenant, member } = membership
      const db = forTenant(tenant.id)

      await db.query(
        `INSERT INTO voice_call_sessions (tenant_id, session_id, user_id, status, started_at)
         VALUES ($1, $2, $3, 'connected', now())
         ON CONFLICT (session_id) DO NOTHING`,
        [tokenPayload.sid, user.id],
      )

      const status = (state: VoiceState) => sendJson(socket, { type: 'status', state })

      const respond = async (transcript: string): Promise<void> => {
        if (activeTurns >= 2) return
        activeTurns += 1
        const generation = generations.next()
        status('thinking')
        try {
          const charge = await chargeGate(tenant.id, 'voice', {
            refType: 'voice_call',
            refId: tokenPayload.sid,
          })
          const output = await processMessage({
            tenant,
            user,
            member,
            message: transcript,
            semanticQuery: transcript,
            voiceCall: true,
          })
          const spoken = shortSpokenReply(output.reply)
          if (!spoken || !generations.isCurrent(generation) || closed) return

          const audio = await synthesize({ text: spoken })
          if (!generations.isCurrent(generation) || closed) return
          status('speaking')
          socket.send(audio.mp3, { binary: true })
          sendJson(socket, { type: 'audio:done', generation, durationMs: audio.durationMs })

          const conv = await db.query<{ id: number }>(
            `INSERT INTO conversations
               (tenant_id, user_id, message_type, user_message, ai_response, points_charged, metadata)
             VALUES ($1, $2, 'voice_call', $3, $4, $5, $6) RETURNING id`,
            [user.id, transcript, spoken, charge.cost, JSON.stringify({ sessionId: tokenPayload.sid })],
          )
          void extractAndLearn({
            tenantId: tenant.id,
            conversationId: conv.rows[0]?.id ?? null,
            userId: user.id,
            userName: user.display_name ?? '對方',
            userMessage: transcript,
            aiResponse: spoken,
            canShapeSoul: user.can_shape_soul,
          }).catch((error) => request.log.warn({ err: error }, 'voice call memory learner failed'))
          await db.query(
            `UPDATE voice_call_sessions
             SET turn_count = turn_count + 1, updated_at = now()
             WHERE tenant_id = $1 AND session_id = $2`,
            [tokenPayload.sid],
          )
        } catch (error) {
          request.log.error({ err: error, sessionId: tokenPayload.sid }, 'voice turn failed')
          const message = error instanceof InsufficientPointsError
            ? '目前點數不足，暫時無法繼續通話。'
            : '剛剛訊號有點不穩，請再說一次。'
          sendJson(socket, { type: 'error', message })
        } finally {
          activeTurns -= 1
          if (!closed && generations.isCurrent(generation)) status('listening')
        }
      }

      deepgram = new DeepgramStream({
        onOpen: () => request.log.info({ sessionId: tokenPayload.sid }, 'Deepgram stream connected'),
        onError: (error) => request.log.error({ err: error, sessionId: tokenPayload.sid }, 'Deepgram stream error'),
        onTranscript: ({ text, isFinal, speechFinal }) => {
          if (!isFinal) {
            status('hearing')
            return
          }
          finalParts.push(text)
          if (!speechFinal) return
          const utterance = finalParts.join(' ').trim()
          finalParts = []
          if (utterance) void respond(utterance)
        },
      })

      handleMessage = (raw, isBinary) => {
        if (isBinary) {
          if (sessionStarted) deepgram?.sendAudio(raw)
          return
        }
        let message: { type?: string }
        try {
          message = JSON.parse(raw.toString()) as { type?: string }
        } catch {
          return
        }
        if (message.type === 'call:start' && !sessionStarted && !sessionStarting) {
          sessionStarting = true
          try {
            void deepgram?.connect().then(() => {
              sessionStarted = true
              sessionStarting = false
              sendJson(socket, { type: 'call:ready', greeting: '我是饅頭，我在。' })
              status('listening')
            }).catch((error) => {
              sessionStarting = false
              request.log.error({ err: error }, 'voice recognition start failed')
              sendJson(socket, { type: 'error', message: '語音辨識尚未完成設定。' })
            })
          } catch (error) {
            request.log.error({ err: error }, 'voice recognition start failed')
          }
        } else if (message.type === 'audio:interrupt') {
          generations.cancel()
          finalParts = []
          sendJson(socket, { type: 'audio:fadeout' })
          sendJson(socket, { type: 'audio:clear' })
          status('interrupting')
          status('listening')
        } else if (message.type === 'call:end') {
          sendJson(socket, { type: 'call:ended' })
          socket.close(1000, 'caller_hangup')
        }
      }
      for (const pending of pendingMessages.splice(0)) handleMessage(pending.raw, pending.isBinary)

      const closeSession = async (reason: string): Promise<void> => {
        if (closed) return
        closed = true
        generations.cancel()
        deepgram?.close()
        await db.query(
          `UPDATE voice_call_sessions
           SET status = 'ended', ended_at = now(), close_reason = $3, updated_at = now()
           WHERE tenant_id = $1 AND session_id = $2`,
          [tokenPayload.sid, reason],
        ).catch((error) => request.log.warn({ err: error }, 'voice session close persistence failed'))
      }
      socket.on('close', (_code, reason) => void closeSession(reason.toString() || 'socket_closed'))
      socket.on('error', (error) => {
        request.log.warn({ err: error, sessionId: tokenPayload.sid }, 'voice websocket error')
        void closeSession('socket_error')
      })
    } catch (error) {
      request.log.warn({ err: error }, 'voice websocket authorization failed')
      sendJson(socket, { type: 'error', message: '通話授權已失效，請重新開啟。' })
      socket.close(1008, 'unauthorized')
    }
  })
}
