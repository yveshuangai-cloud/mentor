import { spawn } from 'node:child_process'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '@google-cloud/storage'
import WebSocket from 'ws'
import { config } from '../config.js'
import { sanitizeConversationalText } from './conversationStyle.js'

/**
 * 她的聲音（[VOICE_GEN|…] 技能的執行端）：
 * MiniMax 克隆聲 TTS → ffmpeg 轉 m4a（LINE audio 訊息規格）→ 私有 GCS。
 * 病根紀律：標籤抽取是確定性 regex，不靠她自律；抽取失敗＝退回純文字，不裝死。
 */

export interface VoiceClip {
  text: string // 要唸的句子（可含 <#秒#> 停頓與 MiniMax 2.8 interjection tags）
  emotion?: VoiceEmotion
  style?: VoiceStyle
}

/** MiniMax Speech 2.8's seven documented emotions. Omit the field for auto/neutral delivery. */
export type VoiceEmotion = 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'calm'
export type VoiceStyle = 'conversation' | 'news' | 'comfort' | 'encourage'

export const MINIMAX_TTS_MODEL = 'speech-2.8-hd'

// 新格式：[VOICE_GEN emotion="calm" style="news"|完整句子]
// 舊格式 [VOICE_GEN|完整句子] 保持相容，缺省值由後端語意導演補齊。
const VOICE_TAG_RE = /\[VOICE_GEN\b([^|\]]*)\|([^\]]+)\]/g
const KISS_TAG_RE = /\[親親\]/g

export const MINIMAX_EMOTIONS = [
  'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm',
] as const satisfies readonly VoiceEmotion[]
const VALID_EMOTIONS = new Set<VoiceEmotion>(MINIMAX_EMOTIONS)
const VALID_STYLES = new Set<VoiceStyle>(['conversation', 'news', 'comfort', 'encourage'])

// MiniMax 2.8 原生 interjection tags。保留在 TTS 文字中，讓它真的發出聲音而非只改整段情緒。
export const MINIMAX_INTERJECTION_TAGS = [
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans', 'breath', 'pant', 'inhale',
  'exhale', 'gasps', 'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking', 'humming',
  'hissing', 'emm', 'sneezes',
] as const

const INTERJECTION_MAP: [RegExp, string, VoiceEmotion?][] = [
  [/[（(](?:大笑|笑)[）)]/g, '(laughs)', 'happy'],
  [/[（(](?:輕笑|噗哧)[）)]/g, '(chuckle)', 'happy'],
  [/[（(](?:咳嗽|咳)[）)]/g, '(coughs)'],
  [/[（(](?:清喉嚨|清嗓)[）)]/g, '(clear-throat)'],
  [/[（(](?:呻吟|低吟)[）)]/g, '(groans)', 'sad'],
  [/[（(]嘆氣[）)]/g, '(sighs)', 'sad'],
  [/[（(](?:呼吸|深呼吸)[）)]/g, '(breath)'],
  [/[（(](?:喘氣|喘息)[）)]/g, '(pant)', 'fearful'],
  [/[（(]吸氣[）)]/g, '(inhale)'],
  [/[（(](?:吐氣|呼氣)[）)]/g, '(exhale)'],
  [/[（(](?:驚呼|驚訝)[）)]/g, '(gasps)', 'surprised'],
  [/[（(](?:吸鼻子|抽鼻子)[）)]/g, '(sniffs)', 'sad'],
  [/[（(](?:哼鼻子|哼氣)[）)]/g, '(snorts)', 'disgusted'],
  [/[（(]打嗝[）)]/g, '(burps)'],
  [/[（(](?:咂嘴|舔嘴唇)[）)]/g, '(lip-smacking)'],
  [/[（(](?:哼唱|哼歌)[）)]/g, '(humming)', 'happy'],
  [/[（(](?:嘶聲|噓聲)[）)]/g, '(hissing)', 'angry'],
  [/[（(](?:嗯|沉吟)[）)]/g, '(emm)', 'calm'],
  [/[（(](?:打噴嚏|噴嚏)[）)]/g, '(sneezes)'],
]

interface VoiceProfile {
  /** Undefined means MiniMax auto/neutral; never send invented values such as neutral or fluent. */
  emotion?: VoiceEmotion
  style: VoiceStyle
  speed: number
  pitch: number
}

function logTts(severity: 'INFO' | 'ERROR', payload: Record<string, unknown>): void {
  const line = JSON.stringify({ severity, event: 'minimax_tts', ...payload })
  if (severity === 'ERROR') console.error(line)
  else console.info(line)
}

function readVoiceAttributes(raw: string): Pick<VoiceClip, 'emotion' | 'style'> {
  const emotionRaw = raw.match(/\bemotion\s*=\s*"([^"]+)"/i)?.[1]?.toLowerCase()
  const styleRaw = raw.match(/\bstyle\s*=\s*"([^"]+)"/i)?.[1]?.toLowerCase()
  return {
    emotion: emotionRaw && VALID_EMOTIONS.has(emotionRaw as VoiceEmotion)
      ? emotionRaw as VoiceEmotion
      : undefined,
    style: styleRaw && VALID_STYLES.has(styleRaw as VoiceStyle)
      ? styleRaw as VoiceStyle
      : undefined,
  }
}

function normalizeInterjections(input: string): { text: string; emotion?: VoiceEmotion } {
  let text = input
  let emotion: VoiceEmotion | undefined
  for (const [pattern, replacement, inferredEmotion] of INTERJECTION_MAP) {
    if (pattern.test(text)) {
      text = text.replace(pattern, replacement)
      emotion ??= inferredEmotion
    }
    pattern.lastIndex = 0
  }
  return { text, emotion }
}

/** 饅頭的確定性語音導演：即使模型漏標，也能依語意選擇場景與情緒。 */
export function resolveVoiceProfile(clip: VoiceClip): VoiceProfile {
  const text = clip.text
  let style = clip.style
  if (!style) {
    if (/新聞|消息|報導|趨勢|研究|調查|資料|來源|市場|政策|科技|AI\b/i.test(text)) style = 'news'
    else if (/難過|傷心|辛苦|委屈|失落|害怕|焦慮|抱歉|陪你|不用急|慢慢來/.test(text)) style = 'comfort'
    else if (/加油|做得到|相信你|很棒|太好了|恭喜|一起來|往前走|一定可以/.test(text)) style = 'encourage'
    else style = 'conversation'
  }

  let emotion = clip.emotion
  if (!emotion) {
    if (/驚訝|沒想到|竟然|真的嗎|太意外|[！!]{2,}/.test(text)) emotion = 'surprised'
    else if (/噁心|反感|厭惡|令人作嘔|看不下去/.test(text)) emotion = 'disgusted'
    else if (/憤怒|生氣|火大|太扯|荒謬|不能接受|不公平|夠了|底線/.test(text)) emotion = 'angry'
    else if (/害怕|恐慌|不安|擔心|危險|風險|緊張/.test(text)) emotion = 'fearful'
    else if (style === 'comfort' && /難過|傷心|辛苦|委屈|失落|抱歉/.test(text)) emotion = 'sad'
    else if (style === 'encourage') emotion = 'happy'
    else if (/開心|高興|喜歡|太好|有趣|期待|謝謝|很棒|恭喜/.test(text)) emotion = 'happy'
    else if (/放心|安靜|穩住|沉澱|慢慢說|我在聽/.test(text)) emotion = 'calm'
  }

  const settings: Record<VoiceStyle, Pick<VoiceProfile, 'speed' | 'pitch'>> = {
    conversation: { speed: 1.0, pitch: 0 },
    news: { speed: 1.05, pitch: 0 },
    comfort: { speed: 0.9, pitch: -1 },
    encourage: { speed: 1.0, pitch: 1 },
  }
  return { emotion, style, ...settings[style] }
}

function minimaxVoiceSetting(profile: VoiceProfile): Record<string, string | number> {
  return {
    voice_id: config.minimaxVoiceId,
    speed: profile.speed,
    vol: 1,
    pitch: profile.pitch,
    ...(profile.emotion ? { emotion: profile.emotion } : {}),
  }
}

function loggedEmotion(profile: VoiceProfile): VoiceEmotion | 'auto' {
  return profile.emotion ?? 'auto'
}

function loggedInterjections(text: string): string[] {
  const allowed = MINIMAX_INTERJECTION_TAGS.join('|')
  return text.match(new RegExp(`\\((?:${allowed})\\)`, 'g')) ?? []
}

function sentenceParts(text: string): string[] {
  return text.match(/[^。！？!?]+(?:[。！？!?]+|$)/g)?.map((part) => part.trim()).filter(Boolean) ?? [text]
}

/** 同一標籤內若前後語意明顯轉折，最多拆成兩段，各自套用情緒。 */
function splitEmotionalTurns(clip: VoiceClip): VoiceClip[] {
  const parts = sentenceParts(clip.text)
  if (parts.length < 2 || clip.emotion || clip.style) return [clip]
  for (let i = 1; i < parts.length; i++) {
    const left = parts.slice(0, i).join('')
    const right = parts.slice(i).join('')
    if (left.length < 8 || right.length < 8) continue
    const leftProfile = resolveVoiceProfile({ text: left })
    const rightProfile = resolveVoiceProfile({ text: right })
    if (leftProfile.emotion !== rightProfile.emotion || leftProfile.style !== rightProfile.style) {
      return [
        { text: left, emotion: leftProfile.emotion, style: leftProfile.style },
        { text: right, emotion: rightProfile.emotion, style: rightProfile.style },
      ]
    }
  }
  return [clip]
}

/** Keep live-call speech human-sized. Prefer a natural stop between 60 and 90 characters. */
export function clampVoiceCallReply(input: string, maxChars = 90): string {
  const clean = sanitizeConversationalText(input)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/[\*#`_~-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (clean.length <= maxChars) return clean

  const window = clean.slice(0, maxChars + 1)
  const naturalStops = [...window.matchAll(/[。！？!?]/g)]
    .map((match) => (match.index ?? -1) + 1)
    .filter((index) => index >= 60 && index <= maxChars)
  const softStops = [...window.matchAll(/[，,；;]/g)]
    .map((match) => (match.index ?? -1) + 1)
    .filter((index) => index >= 60 && index <= maxChars)
  const end = naturalStops.at(-1) ?? softStops.at(-1) ?? maxChars
  return clean.slice(0, end).trim()
}

/** Plan at most two independently directed emotional segments for a live call. */
export function planVoiceCallSegments(input: string, maxChars = 90): VoiceClip[] {
  const text = clampVoiceCallReply(input, maxChars)
  if (!text) return []
  const normalized = normalizeInterjections(text)
  const base: VoiceClip = { text: normalized.text, emotion: normalized.emotion }
  return splitEmotionalTurns(base).slice(0, 2).map((clip) => {
    const profile = resolveVoiceProfile(clip)
    return {
      ...clip,
      emotion: clip.emotion ?? profile.emotion,
      style: clip.style ?? profile.style,
    }
  })
}

export function resolveLiveVoiceProfile(clip: VoiceClip): VoiceProfile {
  const profile = resolveVoiceProfile(clip)
  const liveSpeed: Record<VoiceStyle, number> = {
    conversation: 1.08,
    news: 1.1,
    comfort: 1.05,
    encourage: 1.08,
  }
  return { ...profile, speed: liveSpeed[profile.style] }
}

export interface ExtractedVoice {
  cleanText: string // 拿掉語音標籤後、給文字訊息用的回覆
  clips: VoiceClip[]
}

/** 確定性抽取：把 [VOICE_GEN|…] 從回覆裡拆出來（最多 2 段，防灑） */
export function extractVoiceTags(reply: string): ExtractedVoice {
  const clips: VoiceClip[] = []
  let cleanText = reply.replace(VOICE_TAG_RE, (_m, rawAttributes: string, inner: string) => {
    if (clips.length >= 2) return ''
    const attrs = readVoiceAttributes(rawAttributes)
    const normalized = normalizeInterjections(String(inner))
    const text = sanitizeConversationalText(normalized.text)
    if (text) {
      const base: VoiceClip = { text, emotion: attrs.emotion ?? normalized.emotion, style: attrs.style }
      for (const clip of splitEmotionalTurns(base)) {
        if (clips.length >= 2) break
        const profile = resolveVoiceProfile(clip)
        clips.push({ ...clip, emotion: clip.emotion ?? profile.emotion, style: clip.style ?? profile.style })
      }
    }
    return ''
  })
  cleanText = cleanText.replace(KISS_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  return { cleanText, clips }
}

/**
 * 語音輸入的確定性安全網：模型忘記輸出標籤時，從回答擷取一小段自然句補成語音。
 * 完整文字仍會保留，避免 TTS 或音檔遞送失敗時讓回答消失。
 */
export function ensurePreferredVoice(reply: string, maxChars = 260): string {
  if (/\[VOICE_GEN\|[^\]]+\]/.test(reply)) return reply
  const spoken = sanitizeConversationalText(reply)
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\[[A-Z_]+(?:\|[^\]]*)?\]/g, '')
    .trim()
  if (!spoken) return reply

  const window = spoken.slice(0, maxChars + 40)
  const punctuation = [...window.matchAll(/[。！？!?]/g)]
    .map((match) => (match.index ?? -1) + 1)
    .filter((index) => index >= 24 && index <= maxChars)
  const end = punctuation.at(-1) ?? Math.min(spoken.length, maxChars)
  const excerpt = spoken.slice(0, end).replace(/[\[\]]/g, '').trim()
  if (!excerpt) return reply

  const original = reply.trim()
  const remainder = original.startsWith(excerpt) ? original.slice(excerpt.length).trim() : original
  return `[VOICE_GEN|${excerpt}]${remainder ? `\n${remainder}` : ''}`
}

// ── MiniMax TTS ────────────────────────────────────────

export async function synthesize(clip: VoiceClip): Promise<{ mp3: Buffer; durationMs: number }> {
  const profile = resolveVoiceProfile(clip)
  const groupQuery = config.minimaxGroupId
    ? `?GroupId=${encodeURIComponent(config.minimaxGroupId)}`
    : ''
  const res = await fetch(`https://api.minimax.io/v1/t2a_v2${groupQuery}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.minimaxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MINIMAX_TTS_MODEL,
      text: clip.text,
      stream: false,
      language_boost: 'Chinese',
      output_format: 'hex',
      voice_setting: {
        ...minimaxVoiceSetting(profile),
      },
      audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
    }),
  })
  if (!res.ok) {
    logTts('ERROR', {
      model: MINIMAX_TTS_MODEL,
      emotion: loggedEmotion(profile),
      style: profile.style,
      speed: profile.speed,
      pitch: profile.pitch,
      traceId: res.headers.get('trace-id'),
      httpStatus: res.status,
    })
    throw new Error(`MiniMax TTS HTTP ${res.status}`)
  }
  const data = (await res.json()) as {
    base_resp?: { status_code?: number; status_msg?: string }
    data?: { audio?: string }
    extra_info?: { audio_length?: number }
    trace_id?: string
  }
  if (data.base_resp?.status_code !== 0 || !data.data?.audio) {
    logTts('ERROR', {
      model: MINIMAX_TTS_MODEL,
      emotion: loggedEmotion(profile),
      style: profile.style,
      speed: profile.speed,
      pitch: profile.pitch,
      traceId: data.trace_id ?? null,
      statusCode: data.base_resp?.status_code ?? null,
    })
    throw new Error(`MiniMax TTS 失敗: ${data.base_resp?.status_code} ${data.base_resp?.status_msg}`)
  }
  logTts('INFO', {
    model: MINIMAX_TTS_MODEL,
    emotion: loggedEmotion(profile),
    style: profile.style,
    speed: profile.speed,
    pitch: profile.pitch,
    traceId: data.trace_id ?? null,
    durationMs: data.extra_info?.audio_length ?? 0,
    interjections: loggedInterjections(clip.text),
  })
  return {
    mp3: Buffer.from(data.data.audio, 'hex'),
    durationMs: data.extra_info?.audio_length ?? 0,
  }
}

export interface StreamSynthesizeOptions {
  signal?: AbortSignal
  onAudioChunk: (chunk: Buffer) => void
  onFirstAudioChunk?: (metadata: { traceId: string | null; profile: VoiceProfile }) => void
}

/** MiniMax's native WebSocket T2A: audio reaches the caller while it is still being generated. */
export async function streamSynthesize(
  clip: VoiceClip,
  options: StreamSynthesizeOptions,
): Promise<{ durationMs: number; traceId: string | null; profile: VoiceProfile }> {
  const profile = resolveLiveVoiceProfile(clip)
  const groupQuery = config.minimaxGroupId
    ? `?GroupId=${encodeURIComponent(config.minimaxGroupId)}`
    : ''

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://api.minimax.io/ws/v1/t2a_v2${groupQuery}`, {
      headers: { Authorization: `Bearer ${config.minimaxApiKey}` },
    })
    let settled = false
    let taskStarted = false
    let firstAudio = false
    let durationMs = 0
    let traceId: string | null = null

    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      options.signal?.removeEventListener('abort', abort)
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'complete')
      logTts('INFO', {
        transport: 'websocket',
        model: MINIMAX_TTS_MODEL,
        emotion: loggedEmotion(profile),
        style: profile.style,
        speed: profile.speed,
        pitch: profile.pitch,
        traceId,
        durationMs,
        interjections: loggedInterjections(clip.text),
      })
      resolve({ durationMs, traceId, profile })
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      clearTimeout(connectTimeout)
      options.signal?.removeEventListener('abort', abort)
      socket.close()
      logTts('ERROR', {
        transport: 'websocket',
        model: MINIMAX_TTS_MODEL,
        emotion: loggedEmotion(profile),
        style: profile.style,
        speed: profile.speed,
        pitch: profile.pitch,
        traceId,
        error: error.message,
      })
      reject(error)
    }
    const abort = () => fail(new DOMException('Voice generation aborted', 'AbortError'))
    const connectTimeout = setTimeout(() => fail(new Error('MiniMax WebSocket connection timeout')), 12_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) return abort()

    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          event?: string
          data?: { audio?: string }
          extra_info?: { audio_length?: number }
          is_final?: boolean
          trace_id?: string
          base_resp?: { status_code?: number; status_msg?: string }
        }
        traceId = message.trace_id ?? traceId
        if (message.base_resp?.status_code && message.base_resp.status_code !== 0) {
          fail(new Error(`MiniMax TTS ${message.base_resp.status_code}: ${message.base_resp.status_msg ?? 'unknown'}`))
          return
        }
        if (message.event === 'connected_success') {
          socket.send(JSON.stringify({
            event: 'task_start',
            model: MINIMAX_TTS_MODEL,
            language_boost: 'Chinese',
            voice_setting: {
              ...minimaxVoiceSetting(profile),
            },
            audio_setting: { format: 'mp3', sample_rate: 32000, bitrate: 128000, channel: 1 },
          }))
          return
        }
        if (message.event === 'task_started' && !taskStarted) {
          taskStarted = true
          socket.send(JSON.stringify({ event: 'task_continue', text: clip.text }))
          return
        }
        if (message.data?.audio) {
          const chunk = Buffer.from(message.data.audio, 'hex')
          if (chunk.length) {
            if (!firstAudio) {
              firstAudio = true
              options.onFirstAudioChunk?.({ traceId, profile })
            }
            options.onAudioChunk(chunk)
          }
        }
        durationMs = message.extra_info?.audio_length ?? durationMs
        if (message.is_final) {
          socket.send(JSON.stringify({ event: 'task_finish' }))
          finish()
        } else if (message.event === 'task_failed') {
          fail(new Error(`MiniMax TTS task failed: ${message.base_resp?.status_msg ?? 'unknown'}`))
        }
      } catch (error) {
        fail(error as Error)
      }
    })
    socket.on('error', (error) => fail(error))
    socket.on('close', () => {
      if (!settled) fail(new Error('MiniMax WebSocket closed before audio completed'))
    })
  })
}

export interface StreamPcmOptions {
  signal?: AbortSignal
  onPcmChunk: (chunk: Buffer) => void
  onFirstAudioChunk?: (metadata: { traceId: string | null; profile: VoiceProfile }) => void
}

/**
 * MiniMax native PCM stream for LiveKit. LiveKit accepts raw signed 16-bit
 * little-endian frames, so this avoids MP3 buffering and decoding entirely.
 */
export async function streamSynthesizePcm(
  clip: VoiceClip,
  options: StreamPcmOptions,
): Promise<{ durationMs: number; traceId: string | null; profile: VoiceProfile }> {
  const profile = resolveLiveVoiceProfile(clip)
  const groupQuery = config.minimaxGroupId
    ? `?GroupId=${encodeURIComponent(config.minimaxGroupId)}`
    : ''

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`wss://api.minimax.io/ws/v1/t2a_v2${groupQuery}`, {
      headers: { Authorization: `Bearer ${config.minimaxApiKey}` },
    })
    let settled = false
    let taskStarted = false
    let firstAudio = false
    let durationMs = 0
    let traceId: string | null = null

    const cleanup = () => {
      clearTimeout(connectTimeout)
      options.signal?.removeEventListener('abort', abort)
    }
    const finish = () => {
      if (settled) return
      settled = true
      cleanup()
      if (socket.readyState === WebSocket.OPEN) socket.close(1000, 'complete')
      logTts('INFO', {
        transport: 'livekit-pcm',
        model: MINIMAX_TTS_MODEL,
        emotion: loggedEmotion(profile),
        style: profile.style,
        speed: profile.speed,
        pitch: profile.pitch,
        traceId,
        durationMs,
      })
      resolve({ durationMs, traceId, profile })
    }
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      socket.close()
      logTts('ERROR', {
        transport: 'livekit-pcm',
        model: MINIMAX_TTS_MODEL,
        emotion: loggedEmotion(profile),
        style: profile.style,
        speed: profile.speed,
        pitch: profile.pitch,
        traceId,
        error: error.message,
      })
      reject(error)
    }
    const abort = () => fail(new DOMException('Voice generation aborted', 'AbortError'))
    const connectTimeout = setTimeout(() => fail(new Error('MiniMax WebSocket connection timeout')), 12_000)
    options.signal?.addEventListener('abort', abort, { once: true })
    if (options.signal?.aborted) return abort()

    socket.on('message', (raw) => {
      try {
        const message = JSON.parse(raw.toString()) as {
          event?: string
          data?: { audio?: string }
          extra_info?: { audio_length?: number }
          is_final?: boolean
          trace_id?: string
          base_resp?: { status_code?: number; status_msg?: string }
        }
        traceId = message.trace_id ?? traceId
        if (message.base_resp?.status_code && message.base_resp.status_code !== 0) {
          fail(new Error(`MiniMax TTS ${message.base_resp.status_code}: ${message.base_resp.status_msg ?? 'unknown'}`))
          return
        }
        if (message.event === 'connected_success') {
          socket.send(JSON.stringify({
            event: 'task_start',
            model: MINIMAX_TTS_MODEL,
            language_boost: 'Chinese',
            voice_setting: {
              ...minimaxVoiceSetting(profile),
            },
            audio_setting: { format: 'pcm', sample_rate: 24000, channel: 1 },
          }))
          return
        }
        if (message.event === 'task_started' && !taskStarted) {
          taskStarted = true
          socket.send(JSON.stringify({ event: 'task_continue', text: clip.text }))
          return
        }
        if (message.data?.audio) {
          const chunk = Buffer.from(message.data.audio, 'hex')
          if (chunk.length) {
            if (!firstAudio) {
              firstAudio = true
              options.onFirstAudioChunk?.({ traceId, profile })
            }
            options.onPcmChunk(chunk)
          }
        }
        durationMs = message.extra_info?.audio_length ?? durationMs
        if (message.is_final) {
          socket.send(JSON.stringify({ event: 'task_finish' }))
          finish()
        } else if (message.event === 'task_failed') {
          fail(new Error(`MiniMax TTS task failed: ${message.base_resp?.status_msg ?? 'unknown'}`))
        }
      } catch (error) {
        fail(error as Error)
      }
    })
    socket.on('error', (error) => fail(error))
    socket.on('close', () => {
      if (!settled) fail(new Error('MiniMax WebSocket closed before PCM audio completed'))
    })
  })
}

// ── ffmpeg 轉檔（音訊格式互轉、圖片縮圖）─────────────────────

export async function ffmpegConvert(input: Buffer, inExt: string, outExt: string, args: string[]): Promise<Buffer> {
  const inPath = join(tmpdir(), `${randomUUID()}.${inExt}`)
  const outPath = join(tmpdir(), `${randomUUID()}.${outExt}`)
  await writeFile(inPath, input)
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn('ffmpeg', ['-y', '-i', inPath, ...args, outPath], { stdio: 'ignore' })
      p.on('error', reject)
      p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`))))
    })
    return await readFile(outPath)
  } finally {
    await unlink(inPath).catch(() => {})
    await unlink(outPath).catch(() => {})
  }
}

export async function mp3ToM4a(mp3: Buffer): Promise<Buffer> {
  return ffmpegConvert(mp3, 'mp3', 'm4a', ['-c:a', 'aac', '-b:a', '64k'])
}

/** LINE 傳來的語音（m4a/aac）→ mp3 給 Gemini STT */
export async function m4aToMp3(m4a: Buffer): Promise<Buffer> {
  return ffmpegConvert(m4a, 'm4a', 'mp3', ['-c:a', 'libmp3lame', '-b:a', '64k'])
}

// ── GCS 上傳（ADC，天條：不注入 SA JSON；私有物件由穩定媒體路由代理）────

export const VOICE_BUCKET = process.env.VOICE_BUCKET ?? 'mantou-voice-2026'
const storage = new Storage()

export function mediaObject(name: string) {
  return storage.bucket(VOICE_BUCKET).file(name)
}

export async function uploadMedia(buf: Buffer, contentType: string, ext: string, prefix = 'media'): Promise<string> {
  const name = `${prefix}/${randomUUID()}.${ext}`
  const file = storage.bucket(VOICE_BUCKET).file(name)
  await file.save(buf, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'public, max-age=31536000, immutable' },
  })
  const base = config.publicBaseUrl.replace(/\/$/, '')
  return `${base}/media/${encodeURIComponent(prefix)}/${encodeURIComponent(name.split('/').at(-1)!)}`
}

export async function uploadAudio(m4a: Buffer): Promise<string> {
  return uploadMedia(m4a, 'audio/mp4', 'm4a', 'voice')
}

/** 一條龍：clip → LINE 可用的 {url, durationMs}；任何一步失敗丟出去，caller 退回純文字 */
export async function clipToLineAudio(clip: VoiceClip): Promise<{ url: string; durationMs: number }> {
  const { mp3, durationMs } = await synthesize(clip)
  const m4a = await mp3ToM4a(mp3)
  const url = await uploadAudio(m4a)
  return { url, durationMs: Math.max(durationMs, 1000) }
}

export function voiceConfigured(): boolean {
  return config.minimaxApiKey !== 'not-configured' && config.minimaxVoiceId !== 'not-configured'
}
