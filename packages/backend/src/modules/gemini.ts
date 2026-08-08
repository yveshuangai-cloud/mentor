import { config } from '../config.js'

/**
 * Gemini 執行端：聽音檔（STT）＋畫圖（生圖）。
 * 兩者都是「她的技能」的手——判斷歸大腦（Claude），執行歸這裡。
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models'

interface GeminiPart {
  text?: string
  thought?: boolean
  inlineData?: { mimeType: string; data: string }
  inline_data?: { mime_type: string; data: string }
}

interface GeminiGenerationConfig {
  thinkingConfig?: { thinkingLevel: 'minimal' | 'low' | 'medium' | 'high' }
}

async function geminiCall(
  model: string,
  parts: unknown[],
  generationConfig?: GeminiGenerationConfig,
): Promise<GeminiPart[]> {
  const res = await fetch(`${GEMINI_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': config.geminiApiKey,
    },
    body: JSON.stringify({
      contents: [{ parts }],
      ...(generationConfig ? { generationConfig } : {}),
    }),
  })
  if (!res.ok) throw new Error(`Gemini ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const data = (await res.json()) as {
    candidates?: { content?: { parts?: GeminiPart[] } }[]
  }
  return data.candidates?.[0]?.content?.parts ?? []
}

/** 語音轉文字（mp3/aac 皆可） */
export async function transcribeAudio(audio: Buffer, mimeType: string): Promise<string> {
  const parts = await geminiCall(
    'gemini-3.6-flash',
    [
      { inline_data: { mime_type: mimeType, data: audio.toString('base64') } },
      { text: '逐字轉錄這段音檔的內容（繁體中文），只回轉錄文字，不加任何說明。' },
    ],
    { thinkingConfig: { thinkingLevel: 'minimal' } },
  )
  const text = parts
    .filter((p) => !p.thought)
    .map((p) => p.text ?? '')
    .join('')
    .trim()
  if (!text) throw new Error('Gemini STT 回空')
  return text
}

/** 生圖：回 PNG buffer */
export async function generateImage(prompt: string): Promise<Buffer> {
  const parts = await geminiCall('gemini-2.5-flash-image', [{ text: prompt }])
  const img = parts.find((p) => p.inlineData?.data || p.inline_data?.data)
  const b64 = img?.inlineData?.data ?? img?.inline_data?.data
  if (!b64) throw new Error('Gemini 生圖回空（可能觸發安全過濾）')
  return Buffer.from(b64, 'base64')
}

export function geminiConfigured(): boolean {
  return config.geminiApiKey !== 'not-configured'
}
