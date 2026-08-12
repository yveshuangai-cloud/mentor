import { fileURLToPath } from 'node:url'
import { ReadableStream } from 'node:stream/web'
import {
  AgentSessionEventTypes,
  AudioByteStream,
  ChatContext,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents'
import { STT as DeepgramSTT } from '@livekit/agents-plugin-deepgram'
import type { AudioFrame } from '@livekit/rtc-node'
import { config } from './config.js'
import { autoMigrate } from './db/index.js'
import { forTenant } from './db/tenantDb.js'
import { processMessage } from './modules/brain.js'
import { extractAndLearn } from './modules/memory/learner.js'
import { chargeGate, InsufficientPointsError } from './modules/points.js'
import { resolveMembership, upsertUser } from './modules/tenancy.js'
import {
  clampVoiceCallReply,
  planVoiceCallSegments,
  streamSynthesizePcm,
} from './modules/voice.js'
import { createShadowTurn, type TurnKernel } from './modules/turnKernel/index.js'

interface MantouParticipantMetadata {
  lineUserId: string
  sessionId: string
}

function parseParticipantMetadata(raw: string): MantouParticipantMetadata {
  const parsed = JSON.parse(raw || '{}') as Partial<MantouParticipantMetadata>
  if (!parsed.lineUserId || !parsed.sessionId) throw new Error('livekit_participant_metadata_invalid')
  return { lineUserId: parsed.lineUserId, sessionId: parsed.sessionId }
}

function latestUserText(chatCtx: ChatContext): string {
  for (let index = chatCtx.items.length - 1; index >= 0; index -= 1) {
    const item = chatCtx.items[index]
    if (item?.type === 'message' && item.role === 'user') return item.textContent?.trim() ?? ''
  }
  return ''
}

const agent = defineAgent({
  entry: async (ctx) => {
    await ctx.connect()
    const participant = await ctx.waitForParticipant()
    const metadata = parseParticipantMetadata(participant.metadata)
    const user = await upsertUser(metadata.lineUserId, {})
    const membership = await resolveMembership(user.id)
    if (!membership || membership.member.status !== 'confirmed' || membership.tenant.status !== 'active') {
      throw new Error('voice_membership_not_active')
    }
    const { tenant, member } = membership
    const db = forTenant(tenant.id)
    let activeTurn: TurnKernel | null = null
    let pendingTurnFinish: {
      turn: TurnKernel
      conversationId: number | null
      deliveredText: string
      metadata: Record<string, unknown>
    } | null = null

    await db.query(
      `INSERT INTO voice_call_sessions (tenant_id, session_id, user_id, status, started_at)
       VALUES ($1, $2, $3, 'connected', now())
       ON CONFLICT (session_id) DO UPDATE SET status = 'connected', updated_at = now()`,
      [metadata.sessionId, user.id],
    )

    const mantou = voice.Agent.create({
      instructions: '你是饅頭。所有人格、記憶與知識必須由既有饅頭大腦 processMessage 載入。',
      async llmNode(_agentContext, chatCtx) {
        const transcript = latestUserText(chatCtx)
        if (!transcript) return new ReadableStream<string>({ start: (controller) => controller.close() })

        const turn = createShadowTurn({
          tenantId: tenant.id,
          userId: user.id,
          channel: 'livekit_voice',
          inputText: transcript,
          contentKind: 'audio',
          metadata: { sessionId: metadata.sessionId },
        })
        activeTurn = turn
        turn.mark('stt.completed', { provider: 'deepgram_livekit' })

        return new ReadableStream<string>({
          start(controller) {
            const turnStartedAt = Date.now()
            let firstSentence = ''
            let chargedPoints = 0

            void (async () => {
              try {
                const charge = await chargeGate(tenant.id, 'voice', {
                  refType: 'voice_call',
                  refId: metadata.sessionId,
                  exempt: user.can_shape_soul,
                })
                chargedPoints = charge.cost
                const output = await processMessage({
                  tenant,
                  user,
                  member,
                  message: transcript,
                  semanticQuery: transcript,
                  voiceCall: true,
                  onLlmFirstToken: () => console.info(JSON.stringify({
                    event: 'livekit_voice_latency',
                    stage: 'llm_first_token',
                    sessionId: metadata.sessionId,
                    latencyMs: Date.now() - turnStartedAt,
                  })),
                  onVoiceSentence: (sentence) => {
                    if (firstSentence) return
                    firstSentence = clampVoiceCallReply(sentence, 90)
                    if (firstSentence) controller.enqueue(firstSentence)
                  },
                  turn,
                })
                const spoken = clampVoiceCallReply(output.reply, 90)
                const remaining = firstSentence && spoken.startsWith(firstSentence)
                  ? spoken.slice(firstSentence.length).trim()
                  : firstSentence
                    ? ''
                    : spoken
                if (remaining) controller.enqueue(remaining)

                const conv = await db.query<{ id: number }>(
                  `INSERT INTO conversations
                     (tenant_id, user_id, message_type, user_message, ai_response, points_charged, metadata)
                   VALUES ($1, $2, 'voice_call', $3, $4, $5, $6) RETURNING id`,
                  [user.id, transcript, spoken, chargedPoints, JSON.stringify({
                    sessionId: metadata.sessionId,
                    transport: 'livekit',
                  })],
                )
                pendingTurnFinish = {
                  turn,
                  conversationId: conv.rows[0]?.id ?? null,
                  deliveredText: spoken,
                  metadata: { pointsCharged: chargedPoints, sessionId: metadata.sessionId },
                }
                void extractAndLearn({
                  tenantId: tenant.id,
                  conversationId: conv.rows[0]?.id ?? null,
                  userId: user.id,
                  userName: user.display_name ?? '使用者',
                  userMessage: transcript,
                  aiResponse: spoken,
                  canShapeSoul: user.can_shape_soul,
                }).catch((error) => console.warn('LiveKit memory learner failed', error))
                await db.query(
                  `UPDATE voice_call_sessions
                   SET turn_count = turn_count + 1, updated_at = now()
                   WHERE tenant_id = $1 AND session_id = $2`,
                  [metadata.sessionId],
                )
                controller.close()
              } catch (error) {
                if (error instanceof InsufficientPointsError) {
                  controller.enqueue('目前語音額度不足，我們先用文字聊。')
                  controller.close()
                  return
                }
                turn.fail(error, 'livekit_voice_turn')
                controller.error(error)
              }
            })()
          },
        })
      },
      async *ttsNode(_agentContext, text) {
        for await (const raw of text) {
          const clips = planVoiceCallSegments(raw, 90)
          for (let index = 0; index < clips.length; index += 1) {
            const clip = clips[index]!
            const pcm = new AudioByteStream(24_000, 1, 2_400)
            const startedAt = Date.now()
            let streamOpen = true
            const frames = new ReadableStream<AudioFrame>({
              start(controller) {
                const enqueue = (frame: AudioFrame) => {
                  if (!streamOpen) return
                  try {
                    controller.enqueue(frame)
                  } catch {
                    // LiveKit can cancel playout while MiniMax is still
                    // delivering its final chunks. Treat cancellation as a
                    // normal terminal state instead of erroring a closed
                    // ReadableStream controller.
                    streamOpen = false
                  }
                }
                void streamSynthesizePcm(clip, {
                  onFirstAudioChunk: ({ traceId, profile }) => {
                    const stageMs = Date.now() - startedAt
                    console.info(JSON.stringify({
                      event: 'livekit_voice_latency',
                      stage: 'tts_first_audio',
                      sessionId: metadata.sessionId,
                      segmentIndex: index,
                      latencyMs: stageMs,
                      model: 'speech-2.8-hd',
                      emotion: profile.emotion,
                      style: profile.style,
                      speed: profile.speed,
                      traceId,
                    }))
                    activeTurn?.mark('tts.first_audio', {
                      provider: 'minimax',
                      segmentIndex: index,
                      stageMs,
                      traceId,
                      emotion: profile.emotion,
                      style: profile.style,
                      speed: profile.speed,
                    })
                  },
                  onPcmChunk: (chunk) => {
                    for (const frame of pcm.write(chunk)) enqueue(frame)
                  },
                }).then(() => {
                  if (!streamOpen) return
                  for (const frame of pcm.flush()) enqueue(frame)
                  if (!streamOpen) return
                  streamOpen = false
                  controller.close()
                }).catch((error) => {
                  if (!streamOpen) return
                  streamOpen = false
                  controller.error(error)
                })
              },
              cancel() {
                streamOpen = false
              },
            })
            for await (const frame of frames) yield frame
          }
        }
        if (pendingTurnFinish) {
          pendingTurnFinish.turn.finish({
            conversationId: pendingTurnFinish.conversationId,
            deliveredText: pendingTurnFinish.deliveredText,
            metadata: pendingTurnFinish.metadata,
          })
          pendingTurnFinish = null
        }
      },
    })

    const session = new voice.AgentSession({
      // The framework-provisioned inference VAD consumed room audio but the
      // parallel STT branch never emitted usage or transcript events in the
      // production JS 1.6.2 pipeline. Deepgram already emits SpeechStarted and
      // EndOfSpeech for turnDetection='stt', so keep the base call path on that
      // single, verified detector until adaptive interruption is isolated.
      vad: null,
      stt: new DeepgramSTT({
        apiKey: config.deepgramApiKey,
        // Deepgram rejects several newer boolean query parameters for this
        // project's zh-TW streaming model, even when their value is false.
        // Undefined overrides keep the plugin URL on the proven minimal set.
        model: 'nova-2',
        language: 'zh-TW',
        // LiveKit/WebRTC delivers decoded microphone audio at 48 kHz. Keeping
        // Deepgram at the native rate avoids rtc-node's 48→16 kHz resampler,
        // which produced non-speech PCM and empty zh-TW transcripts in E2E.
        sampleRate: 48_000,
        interimResults: true,
        smartFormat: true,
        punctuate: undefined,
        dictation: undefined,
        diarize: undefined,
        numerals: undefined,
        noDelay: undefined,
        fillerWords: undefined,
        profanityFilter: undefined,
        mipOptOut: undefined,
        endpointing: 250,
        // Deepgram requires utterance_end_ms >= 1000. 700 made the streaming
        // WebSocket fail with HTTP 400 before any transcript could be emitted.
        utteranceEndMs: 1_000,
      }),
      turnHandling: {
        // Commit final Deepgram segments explicitly below. The JS 1.6.2
        // built-in STT endpointing emitted final transcripts and user-state
        // transitions but never scheduled the LLM turn in production.
        turnDetection: 'manual',
        endpointing: { mode: 'fixed', minDelay: 200, maxDelay: 800 },
        interruption: { enabled: false, mode: 'vad', minDuration: 250, minWords: 1 },
        preemptiveGeneration: { enabled: true, preemptiveTts: false },
      },
      userAwayTimeout: null,
      aecWarmupDuration: 1_000,
    })

    let pendingTranscript = ''
    let transcriptCommitTimer: NodeJS.Timeout | null = null

    const scheduleTranscriptCommit = () => {
      if (transcriptCommitTimer) clearTimeout(transcriptCommitTimer)
      // Deepgram can finalize one segment and begin the next more than one
      // second later for Mandarin punctuation. A 1.5 s quiet window merges the
      // whole utterance; this small bounded delay prevents duplicate replies.
      const commitDelayMs = 1_500
      transcriptCommitTimer = setTimeout(() => {
        const userInput = pendingTranscript.trim()
        pendingTranscript = ''
        transcriptCommitTimer = null
        if (!userInput) return
        console.info(JSON.stringify({
          event: 'livekit_manual_turn_commit',
          sessionId: metadata.sessionId,
          transcriptChars: userInput.length,
        }))
        void (async () => {
          // AgentSession.generateReply() requires a framework LLM instance even
          // when this agent supplies a custom llmNode. Mantou intentionally
          // routes replies through processMessage(), so invoke that node and
          // hand its text stream to say(); this preserves the normal TTS/output
          // pipeline without adding a second LLM provider.
          const chatCtx = ChatContext.empty()
          chatCtx.addMessage({ role: 'user', content: userInput })
          const reply = await mantou.llmNode(chatCtx, mantou.toolCtx, {})
          if (!reply) return
          const [transcriptText, spokenText] = (reply as ReadableStream<string>).tee()
          const audio = await mantou.ttsNode(spokenText, {})
          if (!audio) throw new Error('livekit_custom_tts_stream_missing')
          session.say(transcriptText, {
            audio,
            allowInterruptions: false,
            addToChatCtx: false,
          })
        })().catch((error) => {
          console.error(JSON.stringify({
            event: 'livekit_manual_turn_error',
            sessionId: metadata.sessionId,
            error: error instanceof Error ? error.message : String(error),
          }))
        })
      }, commitDelayMs)
    }

    session.on(AgentSessionEventTypes.MetricsCollected, (event) => {
      console.info(JSON.stringify({
        event: 'livekit_agent_metrics',
        sessionId: metadata.sessionId,
        metrics: event.metrics,
      }))
    })
    session.on(AgentSessionEventTypes.UserStateChanged, (event) => {
      console.info(JSON.stringify({
        event: 'livekit_user_state',
        sessionId: metadata.sessionId,
        oldState: event.oldState,
        newState: event.newState,
      }))
    })
    session.on(AgentSessionEventTypes.UserInputTranscribed, (event) => {
      console.info(JSON.stringify({
        event: 'livekit_transcript',
        sessionId: metadata.sessionId,
        isFinal: event.isFinal,
        transcriptChars: event.transcript.length,
        language: event.language,
      }))
      if (event.isFinal && event.transcript.trim()) {
        pendingTranscript = `${pendingTranscript} ${event.transcript.trim()}`.trim()
      }
      // Any new interim/final activity extends the utterance debounce so a
      // short pause inside one sentence does not create two assistant replies.
      scheduleTranscriptCommit()
    })
    session.on(AgentSessionEventTypes.AgentStateChanged, (event) => {
      console.info(JSON.stringify({
        event: 'livekit_agent_state',
        sessionId: metadata.sessionId,
        oldState: event.oldState,
        newState: event.newState,
      }))
    })
    session.on(AgentSessionEventTypes.Error, (event) => {
      console.error(JSON.stringify({ event: 'livekit_agent_error', sessionId: metadata.sessionId, error: event }))
    })

    ctx.addShutdownCallback(async () => {
      if (transcriptCommitTimer) clearTimeout(transcriptCommitTimer)
      await db.query(
        `UPDATE voice_call_sessions
         SET status = 'ended', ended_at = now(), close_reason = 'livekit_disconnected', updated_at = now()
         WHERE tenant_id = $1 AND session_id = $2`,
        [metadata.sessionId],
      ).catch((error) => console.warn('LiveKit session close persistence failed', error))
    })

    await session.start({
      agent: mantou,
      room: ctx.room,
      // RoomIO defaults microphone input to 24 kHz. That forced a 48→24 kHz
      // conversion here and then a second 24→48 kHz rtc-node resample in the
      // Deepgram stream. The double conversion produced active audio tracks
      // with no recognizable speech. Preserve WebRTC's native 48 kHz from the
      // room all the way into Deepgram.
      inputOptions: { audioSampleRate: 48_000, audioNumChannels: 1 },
    })
  },
})

export default agent

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await autoMigrate((message) => console.info(message))
  cli.runApp(new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: config.livekitAgentName,
    wsURL: config.livekitUrl,
    apiKey: config.livekitApiKey,
    apiSecret: config.livekitApiSecret,
    host: '0.0.0.0',
    port: config.port,
    production: config.nodeEnv === 'production',
  }))
}
