import { config } from '../../config.js'
import { platformQuery } from '../../db/index.js'

export interface AieqIdentity {
  userId: number
  lineUserId: string
  displayName?: string
  pictureUrl?: string
}

interface LineVerifiedToken {
  sub: string
  name?: string
  picture?: string
  exp: number
}

const cache = new Map<string, { identity: AieqIdentity; expiresAt: number }>()
const CACHE_MAX = 5_000

// LINE rotates ID tokens roughly hourly, so without eviction the map grows with every login.
function remember(idToken: string, entry: { identity: AieqIdentity; expiresAt: number }): void {
  const now = Date.now()
  if (cache.size >= CACHE_MAX) {
    for (const [key, value] of cache) if (value.expiresAt <= now) cache.delete(key)
    while (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string)
  }
  cache.set(idToken, entry)
}

export async function verifyLiffIdToken(idToken: string): Promise<AieqIdentity> {
  // Local-only escape hatch for hands-on demos. Production remains fail-closed
  // even if AIEQ_DEMO_MODE is accidentally present in its environment.
  // "local-demo:<device id>" gives every browser its own demo player, so several phones
  // on the same LAN demo no longer overwrite each other's progress.
  const demo = config.nodeEnv !== 'production' && config.aieqDemoMode
    ? /^local-demo(?::([A-Za-z0-9-]{8,40}))?$/.exec(idToken)
    : null
  if (demo) {
    const lineUserId = demo[1] ? `LOCAL-AIEQ-DEMO-${demo[1]}` : 'LOCAL-AIEQ-DEMO'
    const result = await platformQuery<{ id: number }>(
      `INSERT INTO users (line_user_id,display_name)
       VALUES ($1,'本機展示者')
       ON CONFLICT (line_user_id) DO UPDATE SET updated_at=now()
       RETURNING id`,
      [lineUserId],
    )
    return { userId: result.rows[0].id, lineUserId, displayName: '本機展示者' }
  }
  if (config.lineLoginChannelId === 'not-configured') throw new Error('line_login_not_configured')
  const cached = cache.get(idToken)
  if (cached && cached.expiresAt > Date.now() + 10_000) return cached.identity

  const body = new URLSearchParams({ id_token: idToken, client_id: config.lineLoginChannelId })
  const response = await fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!response.ok) throw new Error('invalid_line_id_token')
  const verified = await response.json() as LineVerifiedToken
  if (!verified.sub || verified.exp * 1000 <= Date.now()) throw new Error('expired_line_id_token')

  const result = await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id,display_name,picture_url)
     VALUES ($1,$2,$3)
     ON CONFLICT (line_user_id) DO UPDATE SET
       display_name=COALESCE(EXCLUDED.display_name,users.display_name),
       picture_url=COALESCE(EXCLUDED.picture_url,users.picture_url),updated_at=now()
     RETURNING id`,
    [verified.sub, verified.name ?? null, verified.picture ?? null],
  )
  const identity = {
    userId: result.rows[0].id,
    lineUserId: verified.sub,
    displayName: verified.name,
    pictureUrl: verified.picture,
  }
  remember(idToken, { identity, expiresAt: verified.exp * 1000 })
  return identity
}

export function bearerToken(header: string | undefined): string {
  const match = header?.match(/^Bearer\s+(.+)$/i)
  if (!match) throw new Error('missing_bearer_token')
  return match[1]
}
