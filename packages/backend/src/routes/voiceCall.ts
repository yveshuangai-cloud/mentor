import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import type WebSocket from 'ws'
import { config } from '../config.js'
import { platformQuery } from '../db/index.js'
import { forTenant } from '../db/tenantDb.js'
import { processMessage } from '../modules/brain.js'
import { extractAndLearn } from '../modules/memory/learner.js'
import { chargeGate, InsufficientPointsError } from '../modules/points.js'
import { resolveMembership, upsertUser } from '../modules/tenancy.js'
import {
  clampVoiceCallReply,
  planVoiceCallSegments,
  streamSynthesize,
  voiceConfigured,
  type VoiceClip,
} from '../modules/voice.js'
import { issueVoiceToken, verifyLiffIdToken, verifyVoiceToken } from '../modules/voiceCall/auth.js'
import { DeepgramStream } from '../modules/voiceCall/deepgram.js'
import { VoiceGeneration } from '../modules/voiceCall/generation.js'

type VoiceState = 'listening' | 'hearing' | 'thinking' | 'speaking' | 'interrupting'

function sendJson(socket: WebSocket, value: unknown): void {
  if (socket.readyState === 1) socket.send(JSON.stringify(value))
}

export async function voiceCallRoutes(app: FastifyInstance): Promise<void> {
  app.get('/health/services', async (_request, reply) => {
    const intelligenceConfigured = config.bridgeSecret !== '' || config.anthropicApiKey !== 'not-configured'
    const hearingConfigured = config.deepgramApiKey !== 'not-configured'
    const speakingConfigured = voiceConfigured()

    let memoryOk = false
    let memoryNote = 'PostgreSQL unreachable'
    try {
      await platformQuery('SELECT 1')
      memoryOk = true
      memoryNote = 'PostgreSQL connected'
    } catch (error) {
      app.log.warn({ err: error }, 'voice health database probe failed')
    }

    const services = {
      intelligence: {
        ok: intelligenceConfigured,
        note: intelligenceConfigured ? 'LLM configured' : 'LLM not configured',
      },
      memory: { ok: memoryOk, note: memoryNote },
      hearing: {
        ok: hearingConfigured,
        note: hearingConfigured ? 'Deepgram configured' : 'Deepgram not configured',
      },
      speaking: {
        ok: speakingConfigured,
        note: speakingConfigured ? 'MiniMax configured' : 'MiniMax not configured',
      },
    }

    return reply
      .header('Cache-Control', 'no-store')
      .send({ ok: Object.values(services).every((service) => service.ok), services, checkedAt: new Date().toISOString() })
  })

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
    let audioChunks = 0
    let audioBytes = 0
    const websocketStartedAt = Date.now()
    let finalParts: string[] = []
    let activeTurns = 0
    const generations = new VoiceGeneration()
    const activeControllers = new Set<AbortController>()
    const turnStartedAt = new Map<number, number>()
    const firstAudioSentAt = new Map<number, number>()
    let sttStartedAt: number | null = null
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

      const logLatency = (generation: number, stage: string, latencyMs: number, stageMs?: number) => {
        request.log.info({
          event: 'voice_latency',
          stage,
          generation,
          sessionId: tokenPayload.sid,
          latencyMs,
          ...(stageMs == null ? {} : { stageMs }),
        }, `voice latency: ${stage}`)
      }

      const respond = async (transcript: string, sttFinalAt: number): Promise<void> => {
        if (activeTurns >= 2) return
        activeTurns += 1
        const generation = generations.next()
        const controller = new AbortController()
        activeControllers.add(controller)
        turnStartedAt.set(generation, sttFinalAt)
        status('thinking')
        try {
          const charge = await chargeGate(tenant.id, 'voice', {
            refType: 'voice_call',
            refId: tokenPayload.sid,
          })
          let firstSentence = ''
          let firstSegmentTask: Promise<void> | null = null
          let firstSegmentError: Error | null = null
          let ttsStartedAt: number | null = null
          let totalAudioDurationMs = 0

          const sendSegment = async (clip: VoiceClip, segmentIndex: number): Promise<void> => {
            if (!generations.isCurrent(generation) || closed || controller.signal.aborted) return
            const segmentStartedAt = Date.now()
            ttsStartedAt ??= segmentStartedAt
            let announced = false
            const result = await streamSynthesize(clip, {
              signal: controller.signal,
              onFirstAudioChunk: ({ traceId, profile }) => {
                if (!generations.isCurrent(generation) || closed) return
                const now = Date.now()
                if (!firstAudioSentAt.has(generation)) {
                  firstAudioSentAt.set(generation, now)
                  logLatency(generation, 'tts_first_audio', now - sttFinalAt, now - (ttsStartedAt ?? now))
                }
                request.log.info({
                  event: 'voice_segment',
                  sessionId: tokenPayload.sid,
                  generation,
                  segmentIndex,
                  model: 'speech-2.8-hd',
                  emotion: profile.emotion,
                  style: profile.style,
                  speed: profile.speed,
                  pitch: profile.pitch,
                  traceId,
                }, 'voice segment started')
              },
              onAudioChunk: (chunk) => {
                if (!generations.isCurrent(generation) || closed || controller.signal.aborted) return
                if (!announced) {
                  announced = true
                  sendJson(socket, { type: 'audio:segment', generation, segmentIndex })
                  status('speaking')
                }
                socket.send(chunk, { binary: true })
              },
            })
            totalAudioDurationMs += result.durationMs
          }

          const startFirstSentence = (sentence: string) => {
            if (firstSegmentTask || controller.signal.aborted || !generations.isCurrent(generation)) return
            const clip = planVoiceCallSegments(sentence, 90)[0]
            if (!clip) return
            firstSentence = clip.text
            firstSegmentTask = sendSegment(clip, 0).catch((error) => {
              firstSegmentError = error as Error
            })
          }

          let llmFirstTokenLogged = false
          const output = await processMessage({
            tenant,
            user,
            member,
            message: transcript,
            semanticQuery: transcript,
            voiceCall: true,
            signal: controller.signal,
            onLlmFirstToken: () => {
              if (llmFirstTokenLogged) return
              llmFirstTokenLogged = true
              logLatency(generation, 'llm_first_token', Date.now() - sttFinalAt)
            },
            onVoiceSentence: startFirstSentence,
          })
          const spoken = clampVoiceCallReply(output.reply, 90)
          if (!spoken || !generations.isCurrent(generation) || closed) return

          if (!firstSegmentTask) {
            const segments = planVoiceCallSegments(spoken, 90)
            for (let index = 0; index < segments.length; index += 1) {
              await sendSegment(segments[index]!, index)
            }
          } else {
            await firstSegmentTask
            if (firstSegmentError) throw firstSegmentError
            const remaining = spoken.startsWith(firstSentence)
              ? spoken.slice(firstSentence.length).trim()
              : spoken.replace(/^.*?[。！？!?]/s, '').trim()
          const second = planVoiceCallSegments(remaining, Math.max(1, 90 - firstSentence.length))[0]
            if (second) await sendSegment(second, 1)
          }
          if (!generations.isCurrent(generation) || closed || controller.signal.aborted) return
          sendJson(socket, { type: 'audio:done', generation, durationMs: totalAudioDurationMs })

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
          if (controller.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) return
          request.log.error({ err: error, sessionId: tokenPayload.sid }, 'voice turn failed')
          const message = error instanceof InsufficientPointsError
            ? '目前點數不足，暫時無法繼續通話。'
            : '剛剛訊號有點不穩，請再說一次。'
          sendJson(socket, { type: 'error', message })
        } finally {
          activeControllers.delete(controller)
          activeTurns -= 1
          if (!closed && generations.isCurrent(generation)) status('listening')
        }
      }

      deepgram = new DeepgramStream({
        onOpen: () => request.log.info({ sessionId: tokenPayload.sid }, 'Deepgram stream connected'),
        onError: (error) => request.log.error({ err: error, sessionId: tokenPayload.sid }, 'Deepgram stream error'),
        onTranscript: ({ text, isFinal, speechFinal }) => {
          sttStartedAt ??= Date.now()
          if (!isFinal) {
            status('hearing')
            return
          }
          finalParts.push(text)
          if (!speechFinal) return
          const utterance = finalParts.join(' ').trim()
          finalParts = []
          if (utterance) {
            const sttFinalAt = Date.now()
            const observedMs = sttStartedAt == null ? 0 : sttFinalAt - sttStartedAt
            request.log.info({
              event: 'voice_latency',
              stage: 'stt_final',
              sessionId: tokenPayload.sid,
              latencyMs: observedMs,
            }, 'voice latency: stt_final')
            sttStartedAt = null
            void respond(utterance, sttFinalAt)
          }
        },
      })

      handleMessage = (raw, isBinary) => {
        if (isBinary) {
          if (sessionStarted) {
            audioChunks += 1
            audioBytes += raw.byteLength
            if (audioChunks === 1) {
              request.log.info(
                { sessionId: tokenPayload.sid, bytes: raw.byteLength },
                'first microphone audio chunk received',
              )
            }
            deepgram?.sendAudio(raw)
          }
          return
        }
        let message: { type?: string; generation?: number }
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
          for (const controller of activeControllers) controller.abort()
          generations.cancel()
          finalParts = []
          sendJson(socket, { type: 'audio:fadeout' })
          sendJson(socket, { type: 'audio:clear' })
          status('interrupting')
          status('listening')
        } else if (message.type === 'telemetry:playback-start' && Number.isInteger(message.generation)) {
          const generation = message.generation!
          const startedAt = turnStartedAt.get(generation)
          const sentAt = firstAudioSentAt.get(generation)
          if (startedAt != null) {
            const now = Date.now()
            logLatency(generation, 'playback_start', now - startedAt, sentAt == null ? undefined : now - sentAt)
            turnStartedAt.delete(generation)
            firstAudioSentAt.delete(generation)
          }
        } else if (message.type === 'call:end') {
          sendJson(socket, { type: 'call:ended' })
          socket.close(1000, 'caller_hangup')
        }
      }
      for (const pending of pendingMessages.splice(0)) handleMessage(pending.raw, pending.isBinary)

      const closeSession = async (reason: string): Promise<void> => {
        if (closed) return
        closed = true
        for (const controller of activeControllers) controller.abort()
        activeControllers.clear()
        generations.cancel()
        deepgram?.close()
        const summary = {
          sessionId: tokenPayload.sid,
          audioChunks,
          audioBytes,
          durationMs: Date.now() - websocketStartedAt,
          reason,
        }
        if (audioChunks === 0) request.log.warn(summary, 'voice session closed without microphone audio')
        else request.log.info(summary, 'voice session audio summary')
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
