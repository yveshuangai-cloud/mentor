import { initializeLogger } from '@livekit/agents'
import { STT as DeepgramSTT } from '@livekit/agents-plugin-deepgram'
import { AudioFrame } from '@livekit/rtc-node'
import { config } from '../src/config.js'
import { streamSynthesizePcm } from '../src/modules/voice.js'

initializeLogger({ pretty: false, level: 'info' })

const chunks: Buffer[] = []
await streamSynthesizePcm(
  { text: '饅頭你好，請用一句話回答今天的心情。', emotion: 'calm', style: 'conversation' },
  { onPcmChunk: (chunk) => chunks.push(chunk) },
)
const pcm24 = Buffer.concat(chunks)
const source = new Int16Array(pcm24.buffer, pcm24.byteOffset, pcm24.byteLength / 2)
const pcm48 = new Int16Array(source.length * 2)
for (let index = 0; index < source.length; index += 1) {
  const current = source[index] ?? 0
  const next = source[index + 1] ?? current
  pcm48[index * 2] = current
  pcm48[index * 2 + 1] = Math.round((current + next) / 2)
}

const stt = new DeepgramSTT({
  apiKey: config.deepgramApiKey,
  model: 'nova-2',
  language: 'zh-TW',
  sampleRate: 48_000,
  interimResults: true,
  smartFormat: true,
  endpointing: 250,
  utteranceEndMs: 1_000,
})
stt.on('error', (event) => console.error(JSON.stringify({ event: 'deepgram_stream_error', error: String(event.error) })))
const stream = stt.stream()
const result = (async () => {
  for await (const event of stream) {
    const chars = event.alternatives?.[0]?.text.trim().length ?? 0
    console.info(JSON.stringify({ event: 'deepgram_stream_event', type: event.type, chars }))
    // SpeechEventType.FINAL_TRANSCRIPT is a const enum and is erased at runtime.
    if (event.type === 2 && chars > 0) return chars
  }
  return 0
})()

const frameSize = 4_800
for (let offset = 0; offset < pcm48.length; offset += frameSize) {
  const frame = pcm48.subarray(offset, Math.min(offset + frameSize, pcm48.length))
  stream.pushFrame(new AudioFrame(frame, 48_000, 1, frame.length))
}
for (let offset = 0; offset < 48_000 * 2; offset += frameSize) {
  const silence = new Int16Array(frameSize)
  stream.pushFrame(new AudioFrame(silence, 48_000, 1, silence.length))
}
stream.flush()

const transcriptChars = await Promise.race([
  result,
  new Promise<never>((_, reject) => setTimeout(() => reject(new Error('deepgram_stream_timeout')), 20_000)),
])
console.info(JSON.stringify({ ok: transcriptChars > 0, transcriptChars }))
stream.close()
