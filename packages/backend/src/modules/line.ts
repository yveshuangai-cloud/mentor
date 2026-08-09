import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'
import { splitIntoLineBubbles } from './conversationStyle.js'

/** LINE Messaging API 最小封裝（商用 OA；與本尊 OA 完全獨立） */

export function verifyLineSignature(rawBody: string | Buffer, signature: string | undefined): boolean {
  if (!signature || config.lineChannelSecret === 'not-configured') return false
  const mac = createHmac('sha256', config.lineChannelSecret).update(rawBody).digest()
  const given = Buffer.from(signature, 'base64')
  return mac.length === given.length && timingSafeEqual(mac, given)
}

export interface LineTextMessage {
  type: 'text'
  text: string
}

export interface LineAudioMessage {
  type: 'audio'
  originalContentUrl: string // HTTPS m4a
  duration: number // ms
}

export interface LineImageMessage {
  type: 'image'
  originalContentUrl: string // HTTPS jpeg/png ≤10MB
  previewImageUrl: string // HTTPS jpeg ≤1MB
}

export interface LineFlexMessage {
  type: 'flex'
  altText: string
  contents: Record<string, unknown>
}

export type LineMessage = LineTextMessage | LineAudioMessage | LineImageMessage | LineFlexMessage

async function lineApi(path: string, payload: unknown): Promise<void> {
  if (config.lineChannelToken === 'not-configured') {
    console.warn(`[line] channel token 未設定，略過 ${path}`)
    return
  }
  const res = await fetch(`https://api.line.me${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.lineChannelToken}`,
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LINE API ${path} HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
}

export async function replyText(replyToken: string, texts: string[]): Promise<void> {
  const bubbles = texts.flatMap((text) => splitIntoLineBubbles(text, 5)).slice(0, 5)
  await lineApi('/v2/bot/message/reply', {
    replyToken,
    messages: bubbles.map((text): LineTextMessage => ({ type: 'text', text })),
  })
}

/** 混合訊息回覆（文字＋語音；LINE 上限 5 則） */
export async function replyMessages(replyToken: string, messages: LineMessage[]): Promise<void> {
  await lineApi('/v2/bot/message/reply', { replyToken, messages: messages.slice(0, 5) })
}

export async function pushText(lineUserId: string, texts: string[]): Promise<void> {
  const bubbles = texts.flatMap((text) => splitIntoLineBubbles(text, 5)).slice(0, 5)
  await lineApi('/v2/bot/message/push', {
    to: lineUserId,
    messages: bubbles.map((text): LineTextMessage => ({ type: 'text', text })),
  })
}

/** 主動推播混合訊息（研究報告文字＋持久語音等；LINE 上限 5 則）。 */
export async function pushMessages(lineUserId: string, messages: LineMessage[]): Promise<void> {
  await lineApi('/v2/bot/message/push', { to: lineUserId, messages: messages.slice(0, 5) })
}

/**
 * 在一對一聊天室顯示 LINE 原生的三點 loading 動畫。
 * LINE 規格只接受 5–60 秒；OA 一送出真正訊息，動畫會自動消失。
 */
export async function startLoadingAnimation(lineUserId: string, seconds = 60): Promise<void> {
  const loadingSeconds = Math.max(5, Math.min(60, Math.round(seconds)))
  await lineApi('/v2/bot/chat/loading/start', {
    chatId: lineUserId,
    loadingSeconds,
  })
}

/** 下載用戶傳來的媒體內容（圖片/檔案/語音；走 api-data host） */
export async function getMessageContent(
  messageId: string,
): Promise<{ data: Buffer; contentType: string } | null> {
  if (config.lineChannelToken === 'not-configured') return null
  const delays = [0, 500, 1000, 1500, 2500, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    if (delays[attempt] > 0) await new Promise((resolve) => setTimeout(resolve, delays[attempt]))
    const res = await fetch(`https://api-data.line.me/v2/bot/message/${messageId}/content`, {
      headers: { Authorization: `Bearer ${config.lineChannelToken}` },
    })
    // LINE 會在大型音訊仍在準備時回 202；等待後重取，不能把 webhook 當成功吞掉。
    if (res.status === 202) continue
    if (!res.ok) return null
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream'
    return { data: Buffer.from(await res.arrayBuffer()), contentType }
  }
  throw new Error('LINE media content is still processing after retries')
}

export async function getLineProfile(
  lineUserId: string,
): Promise<{ displayName?: string; pictureUrl?: string }> {
  if (config.lineChannelToken === 'not-configured') return {}
  const res = await fetch(`https://api.line.me/v2/bot/profile/${lineUserId}`, {
    headers: { Authorization: `Bearer ${config.lineChannelToken}` },
  })
  if (!res.ok) return {}
  return (await res.json()) as { displayName?: string; pictureUrl?: string }
}
