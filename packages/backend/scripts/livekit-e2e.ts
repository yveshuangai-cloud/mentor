import { randomUUID } from 'node:crypto'
import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  Room,
  RoomEvent,
  TrackKind,
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
  if (track.kind !== TrackKind.KIND_AUDIO) return
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

// Publish the same rate as a browser/WebRTC microphone. Avoid rtc-node's
// AudioResampler in the acceptance test: it previously turned intelligible
// 24 kHz MiniMax speech into PCM that Deepgram could not recognize.
const pcm48Samples = new Int16Array(pcmSamples.length * 2)
for (let index = 0; index < pcmSamples.length; index += 1) {
  const current = pcmSamples[index] ?? 0
  const next = pcmSamples[index + 1] ?? current
  pcm48Samples[index * 2] = current
  pcm48Samples[index * 2 + 1] = Math.round((current + next) / 2)
}
const pcm48 = Buffer.from(pcm48Samples.buffer, pcm48Samples.byteOffset, pcm48Samples.byteLength)

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

const wav48 = Buffer.alloc(44 + pcm48.length)
wav48.write('RIFF', 0)
wav48.writeUInt32LE(36 + pcm48.length, 4)
wav48.write('WAVE', 8)
wav48.write('fmt ', 12)
wav48.writeUInt32LE(16, 16)
wav48.writeUInt16LE(1, 20)
wav48.writeUInt16LE(1, 22)
wav48.writeUInt32LE(48_000, 24)
wav48.writeUInt32LE(96_000, 28)
wav48.writeUInt16LE(2, 32)
wav48.writeUInt16LE(16, 34)
wav48.write('data', 36)
wav48.writeUInt32LE(pcm48.length, 40)
pcm48.copy(wav48, 44)
const rest48Response = await fetch('https://api.deepgram.com/v1/listen?model=nova-2&language=zh-TW&smart_format=true', {
  method: 'POST',
  headers: { Authorization: `Token ${config.deepgramApiKey}`, 'Content-Type': 'audio/wav' },
  body: wav48,
})
const rest48Json = await rest48Response.json() as {
  results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> }
}
const rest48Transcript = rest48Json.results?.channels?.[0]?.alternatives?.[0]?.transcript?.trim() ?? ''
console.info(JSON.stringify({ event: 'e2e_deepgram_rest_48k', ok: rest48Response.ok, transcriptChars: rest48Transcript.length }))
if (!rest48Transcript) throw new Error('e2e_deepgram_rest_48k_empty')

try {
  await room.connect(config.livekitUrl, await token.toJwt(), { autoSubscribe: true })
  const source = new AudioSource(48_000, 1, 1_000)
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
  // Keep the synthetic caller as the room's only remote participant. Agent
  // dispatch is asynchronous, so even an observer joining immediately after
  // createDispatch can win waitForParticipant() and be mistaken for the user.
  // Cloud Run needs a short window to accept the dispatched job and subscribe
  // before the finite synthetic utterance begins; live microphones naturally
  // keep producing frames and do not have this race.
  await new Promise((resolve) => setTimeout(resolve, 3_000))

  const frameBytes = 480 * 2 // 10 ms WebRTC frame, signed 16-bit mono at 48 kHz
  for (let offset = 0; offset < pcm48.length; offset += frameBytes) {
    const chunk = pcm48.subarray(offset, Math.min(offset + frameBytes, pcm48.length))
    const samples = new Int16Array(chunk.buffer, chunk.byteOffset, Math.floor(chunk.byteLength / 2))
    const frame = AudioFrame.create(48_000, 1, samples.length)
    frame.data.set(samples)
    await source.captureFrame(frame)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  const silence = new Int16Array(48_000 * 2)
  for (let offset = 0; offset < silence.length; offset += 480) {
    const samples = silence.subarray(offset, offset + 480)
    const frame = AudioFrame.create(48_000, 1, samples.length)
    frame.data.set(samples)
    await source.captureFrame(frame)
    await new Promise((resolve) => setTimeout(resolve, 10))
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
