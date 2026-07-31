import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config.js'

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
  await lineApi('/v2/bot/message/reply', {
    replyToken,
    messages: texts.slice(0, 5).map((text): LineTextMessage => ({ type: 'text', text })),
  })
}

export async function pushText(lineUserId: string, texts: string[]): Promise<void> {
  await lineApi('/v2/bot/message/push', {
    to: lineUserId,
    messages: texts.slice(0, 5).map((text): LineTextMessage => ({ type: 'text', text })),
  })
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
