import { randomUUID } from 'node:crypto'
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackPublishOptions,
  TrackSource,
  dispose,
} from '@livekit/rtc-node'
import { AccessToken, AgentDispatchClient } from 'livekit-server-sdk'
import { config } from '../src/config.js'
import { streamSynthesizePcm } from '../src/modules/voice.js'

const timeoutMs = 45_000
const sessionId = randomUUID()
const roomName = `mantou-e2e-${sessionId}`
const identity = `e2e-${randomUUID()}`
// Yves already exists as an active production member. The synthetic identity is
// deliberately separate; only participant metadata selects that existing user.
const lineUserId = process.env.E2E_LINE_USER_ID?.trim()
if (!lineUserId) throw new Error('E2E_LINE_USER_ID is required')

const metadata = JSON.stringify({ lineUserId, sessionId })
const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret, {
  identity,
  metadata,
  ttl: '10m',
})
token.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true })

const room = new Room()
let receivedFrames = 0
let receivedSamples = 0
let agentTrackSeen = false
let resolveReply!: () => void
const reply = new Promise<void>((resolve) => { resolveReply = resolve })

room.on(RoomEvent.TrackSubscribed, (track, _publication, participant) => {
  if (track.kind !== 0) return
  agentTrackSeen = true
  void (async () => {
    for await (const frame of new AudioStream(track, { sampleRate: 24_000, numChannels: 1 })) {
      receivedFrames += 1
      receivedSamples += frame.samplesPerChannel
      if (receivedSamples >= 4_800) {
        resolveReply()
        break
      }
    }
  })()
  console.info(JSON.stringify({ event: 'e2e_agent_track', participant: participant.identity }))
})

const pcmChunks: Buffer[] = []
await streamSynthesizePcm(
  { text: '饅頭你好，請用一句話告訴我你有聽見。', emotion: 'calm', style: 'conversation' },
  { onPcmChunk: (chunk) => pcmChunks.push(chunk) },
)
const pcm = Buffer.concat(pcmChunks)
if (pcm.length < 4_800) throw new Error('e2e_tts_pcm_empty')
const pcmSamples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
let peak = 0
let energy = 0
for (const sample of pcmSamples) {
  peak = Math.max(peak, Math.abs(sample))
  energy += sample * sample
}
const rms = Math.sqrt(energy / pcmSamples.length)
console.info(JSON.stringify({ event: 'e2e_pcm', durationMs: Math.round(pcmSamples.length / 24), peak, rms: Math.round(rms) }))
if (peak < 100 || rms < 20) throw new Error('e2e_tts_pcm_silent')

// Prove the source utterance is intelligible to the exact Deepgram model before
// involving LiveKit transport. Keep it at MiniMax's native 24 kHz rate.
const wav24 = Buffer.alloc(44 + pcm.length)
wav24.write('RIFF', 0)
wav24.writeUInt32LE(36 + pcm.length, 4)
wav24.write('WAVE', 8)
wav24.write('fmt ', 12)
wav24.writeUInt32LE(16, 16)
wav24.writeUInt16LE(1, 20)
wav24.writeUInt16LE(1, 22)
wav24.writeUInt32LE(24_000, 24)
wav24.writeUInt32LE(48_000, 28)
wav24.writeUInt16LE(2, 32)
wav24.writeUInt16LE(16, 34)
wav24.write('data', 36)
wav24.writeUInt32LE(pcm.length, 40)
pcm.copy(wav24, 44)
const rest24Response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=zh-TW&smart_format=true', {
  method: 'POST',
  headers: { Authorization: `Token ${config.deepgramApiKey}`, 'Content-Type': 'audio/wav' },
  body: wav24,
})
const rest24Json = await rest24Response.json() as {
  results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
}
const rest24Transcript = rest24Json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? ''
console.info(JSON.stringify({ event: 'e2e_deepgram_rest_24k', ok: rest24Response.ok, transcriptChars: rest24Transcript.length }))
if (!rest24Transcript) throw new Error('e2e_deepgram_rest_24k_empty')

try {
  await room.connect(config.livekitUrl, await token.toJwt(), { autoSubscribe: true })
  const source = new AudioSource(24_000, 1, 1_000)
  const track = LocalAudioTrack.createAudioTrack('e2e-microphone', source)
  const options = new TrackPublishOptions()
  options.source = TrackSource.SOURCE_MICROPHONE
  await room.localParticipant.publishTrack(track, options)
  const dispatch = new AgentDispatchClient(
    config.livekitUrl.replace(/^wss:/, 'https:'),
    config.livekitApiKey,
    config.livekitApiSecret,
  )
  await dispatch.createDispatch(roomName, config.livekitAgentName, { metadata })
  // Cloud Run needs a short window to accept the dispatched job and subscribe
  // before the finite synthetic utterance begins; live microphones naturally
  // keep producing frames and do not have this race.
  await new Promise((resolve) => setTimeout(resolve, 3_000))

  const frameBytes = 2_400 * 2 // 100 ms, signed 16-bit mono at 24 kHz
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    const chunk = pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length))
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
    await source.captureFrame(new AudioFrame(samples, 24_000, 1, samples.length))
  }
  const silence = new Int16Array(24_000 * 2)
  for (let offset = 0; offset < silence.length; offset += 2_400) {
    const samples = silence.subarray(offset, offset + 2_400)
    await source.captureFrame(new AudioFrame(samples, 24_000, 1, samples.length))
  }

  await Promise.race([
    reply,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('e2e_agent_reply_timeout')), timeoutMs)),
  ])
  console.info(JSON.stringify({
    ok: true,
    agentTrackSeen,
    receivedFrames,
    receivedAudioMs: Math.round(receivedSamples / 24),
  }))
  await track.close()
} finally {
  await room.disconnect()
  await dispose()
}
