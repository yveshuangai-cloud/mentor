import { spawn } from 'node:child_process'
import { writeFile, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Storage } from '@google-cloud/storage'
import { config } from '../config.js'

/**
 * 她的聲音（[VOICE_GEN|…] 技能的執行端）：
 * MiniMax 克隆聲 TTS → ffmpeg 轉 m4a（LINE audio 訊息規格）→ GCS 公開桶。
 * 病根紀律：標籤抽取是確定性 regex，不靠她自律；抽取失敗＝退回純文字，不裝死。
 */

export interface VoiceClip {
  text: string // 要唸的句子（含 <#秒#> 停頓，已剝除（情緒）括號）
  emotion?: string // MiniMax emotion 參數
}

const VOICE_TAG_RE = /\[VOICE_GEN\|([^\]]+)\]/g
const KISS_TAG_RE = /\[親親\]/g
// （笑）（嘆氣）等標記 → MiniMax emotion；抽掉括號不讓 TTS 唸出來
const EMOTION_MAP: [RegExp, string][] = [
  [/（(大?笑|輕笑|噗哧)）/, 'happy'],
  [/（嘆氣）/, 'sad'],
  [/（(悄悄|小聲)）/, 'neutral'],
  [/（(驚呼|驚訝)）/, 'surprised'],
]

export interface ExtractedVoice {
  cleanText: string // 拿掉語音標籤後、給文字訊息用的回覆
  clips: VoiceClip[]
}

/** 確定性抽取：把 [VOICE_GEN|…] 從回覆裡拆出來（最多 2 段，防灑） */
export function extractVoiceTags(reply: string): ExtractedVoice {
  const clips: VoiceClip[] = []
  let cleanText = reply.replace(VOICE_TAG_RE, (_m, inner: string) => {
    if (clips.length >= 2) return ''
    let emotion: string | undefined
    let text = String(inner)
    for (const [re, emo] of EMOTION_MAP) {
      if (re.test(text)) {
        emotion = emotion ?? emo
        text = text.replace(re, '')
      }
    }
    text = text.trim()
    if (text) clips.push({ text, emotion })
    return ''
  })
  cleanText = cleanText.replace(KISS_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim()
  return { cleanText, clips }
}

// ── MiniMax TTS ────────────────────────────────────────

export async function synthesize(clip: VoiceClip): Promise<{ mp3: Buffer; durationMs: number }> {
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
      model: 'speech-02-hd',
      text: clip.text,
      voice_setting: {
        voice_id: config.minimaxVoiceId,
        speed: 0.95,
        ...(clip.emotion ? { emotion: clip.emotion } : {}),
      },
      audio_setting: { format: 'mp3', sample_rate: 32000 },
    }),
  })
  if (!res.ok) throw new Error(`MiniMax TTS HTTP ${res.status}`)
  const data = (await res.json()) as {
    base_resp?: { status_code?: number; status_msg?: string }
    data?: { audio?: string }
    extra_info?: { audio_length?: number }
  }
  if (data.base_resp?.status_code !== 0 || !data.data?.audio) {
    throw new Error(`MiniMax TTS 失敗: ${data.base_resp?.status_code} ${data.base_resp?.status_msg}`)
  }
  return {
    mp3: Buffer.from(data.data.audio, 'hex'),
    durationMs: data.extra_info?.audio_length ?? 0,
  }
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

// ── GCS 上傳（ADC，天條：不注入 SA JSON；私有物件用短效 signed URL）────

const VOICE_BUCKET = process.env.VOICE_BUCKET ?? 'mantou-voice-2026'
const storage = new Storage()
const SIGNED_URL_TTL_MS = 15 * 60 * 1000

export async function uploadMedia(buf: Buffer, contentType: string, ext: string, prefix = 'media'): Promise<string> {
  const name = `${prefix}/${randomUUID()}.${ext}`
  const file = storage.bucket(VOICE_BUCKET).file(name)
  await file.save(buf, {
    contentType,
    resumable: false,
    metadata: { cacheControl: 'private, max-age=900' },
  })
  const [url] = await file.getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + SIGNED_URL_TTL_MS,
  })
  return url
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
