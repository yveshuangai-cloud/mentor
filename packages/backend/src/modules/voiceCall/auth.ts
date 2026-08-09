import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { config } from '../../config.js'

export interface LiffIdentity {
  lineUserId: string
  displayName?: string
  pictureUrl?: string
}

interface VoiceTokenPayload {
  sub: string
  sid: string
  exp: number
  iat: number
  nonce: string
}

function encode(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url')
}

function signature(payload: string): string {
  return encode(createHmac('sha256', config.jwtSecret).update(payload).digest())
}

export async function verifyLiffIdToken(idToken: string): Promise<LiffIdentity> {
  if (!idToken) throw new Error('missing_liff_id_token')
  if (config.lineLoginChannelId === 'not-configured') {
    throw new Error('line_login_not_configured')
  }

  const body = new URLSearchParams({
    id_token: idToken,
    client_id: config.lineLoginChannelId,
  })
  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  const result = await response.json().catch(() => ({})) as {
    sub?: string
    name?: string
    picture?: string
    error?: string
    error_description?: string
  }
  if (!response.ok || !result.sub) {
    throw new Error(`invalid_liff_id_token:${result.error ?? response.status}`)
  }
  return {
    lineUserId: result.sub,
    displayName: result.name,
    pictureUrl: result.picture,
  }
}

export function issueVoiceToken(lineUserId: string, sessionId: string, ttlSeconds = 120): string {
  const now = Math.floor(Date.now() / 1000)
  const payload: VoiceTokenPayload = {
    sub: lineUserId,
    sid: sessionId,
    iat: now,
    exp: now + ttlSeconds,
    nonce: randomUUID(),
  }
  const encodedPayload = encode(JSON.stringify(payload))
  return `${encodedPayload}.${signature(encodedPayload)}`
}

export function verifyVoiceToken(token: string): VoiceTokenPayload {
  const [encodedPayload, suppliedSignature, extra] = token.split('.')
  if (!encodedPayload || !suppliedSignature || extra) throw new Error('invalid_voice_token')

  const expected = Buffer.from(signature(encodedPayload))
  const supplied = Buffer.from(suppliedSignature)
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) {
    throw new Error('invalid_voice_token')
  }

  let payload: VoiceTokenPayload
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as VoiceTokenPayload
  } catch {
    throw new Error('invalid_voice_token')
  }
  if (!payload.sub || !payload.sid || !payload.nonce || !Number.isInteger(payload.exp)) {
    throw new Error('invalid_voice_token')
  }
  if (payload.exp <= Math.floor(Date.now() / 1000)) throw new Error('expired_voice_token')
  return payload
}
