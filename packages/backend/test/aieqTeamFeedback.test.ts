import { beforeEach, describe, expect, it, vi } from 'vitest'
import Fastify from 'fastify'

// 「團隊回報小標籤」 routes: gated by AIEQ_TEAM_FEEDBACK, authenticated, validated, rate limited.
const recordTeamFeedback = vi.fn(async () => ({ id: 1, createdAt: '2026-09-18T12:00:00.000Z' }))
const listMyTeamFeedback = vi.fn(async () => ({ intro: { verdict: 'good', comment: null } }))
const summarizeTeamFeedback = vi.fn(async (limit: number) => ({ total: 1, reporters: 1, bySpot: [], entries: [], limit }))

vi.mock('../src/modules/aieq/auth.js', () => ({
  bearerToken: (header?: string) => header?.replace(/^Bearer\s+/i, '') ?? '',
  verifyLiffIdToken: async (token: string) => {
    if (token === 'organiser') return { userId: 1, lineUserId: 'U-organiser', displayName: '威廷' }
    if (token !== 'tester') throw new Error('invalid_token')
    return { userId: 7, lineUserId: 'U-tester', displayName: '測試河狸', pictureUrl: 'https://profile.line-scdn.net/x' }
  },
}))
vi.mock('../src/modules/aieq/teamFeedback.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/modules/aieq/teamFeedback.js')>()),
  recordTeamFeedback: (...args: unknown[]) => recordTeamFeedback(...(args as [])),
  listMyTeamFeedback: (...args: unknown[]) => listMyTeamFeedback(...(args as [])),
  summarizeTeamFeedback: (...args: unknown[]) => summarizeTeamFeedback(...(args as [number])),
}))
vi.mock('../src/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../src/config.js')>()
  return { ...mod, config: { ...mod.config, aieqTeamFeedback: true, aieqAdminLineUserIds: 'U-organiser' } }
})

const { config } = await import('../src/config.js')
const { aieqRoutes } = await import('../src/routes/aieq.js')
const { resetRateLimits } = await import('../src/modules/aieq/rateLimit.js')

async function app() {
  const server = Fastify()
  await server.register(aieqRoutes, { prefix: '/api/aieq' })
  return server
}
const auth = { authorization: 'Bearer tester' }

beforeEach(() => {
  resetRateLimits()
  recordTeamFeedback.mockClear()
  config.aieqTeamFeedback = true
})

describe('team feedback tag', () => {
  it('is advertised through /config only when the flag is on', async () => {
    const server = await app()
    expect((await server.inject({ url: '/api/aieq/config' })).json().teamFeedback).toBe(true)
    config.aieqTeamFeedback = false
    expect((await server.inject({ url: '/api/aieq/config' })).json().teamFeedback).toBe(false)
  })

  it('does not exist at all when the flag is off (production)', async () => {
    config.aieqTeamFeedback = false
    const server = await app()
    const post = await server.inject({ method: 'POST', url: '/api/aieq/team-feedback', headers: auth, payload: { spot: 'intro', verdict: 'good' } })
    const mine = await server.inject({ url: '/api/aieq/team-feedback/mine', headers: auth })
    expect([post.statusCode, mine.statusCode]).toEqual([404, 404])
    expect(recordTeamFeedback).not.toHaveBeenCalled()
  })

  it('records who said what, on which screen, with the browser they used', async () => {
    const server = await app()
    const res = await server.inject({
      method: 'POST', url: '/api/aieq/team-feedback', headers: { ...auth, 'user-agent': 'Line/14.0 iPhone' },
      payload: { spot: 'question:q03_ai_image', verdict: 'issue', comment: '第三題的 B 太長', typeCode: 'out-idea-logic-flex', sessionId: 'sess-1' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true, id: 1, createdAt: '2026-09-18T12:00:00.000Z' })
    expect(recordTeamFeedback).toHaveBeenCalledWith(
      expect.objectContaining({ lineUserId: 'U-tester', displayName: '測試河狸', pictureUrl: 'https://profile.line-scdn.net/x' }),
      { spot: 'question:q03_ai_image', verdict: 'issue', comment: '第三題的 B 太長', typeCode: 'out-idea-logic-flex', sessionId: 'sess-1', userAgent: 'Line/14.0 iPhone' },
    )
  })

  it('rejects unknown spots, verdicts and over-long notes', async () => {
    const server = await app()
    for (const payload of [
      { spot: 'intro', verdict: 'love' },
      { spot: '<script>', verdict: 'good' },
      { spot: 'intro', verdict: 'other', comment: 'x'.repeat(1001) },
      { spot: 'intro', verdict: 'good', typeCode: 'ABCD' },
    ]) {
      const res = await server.inject({ method: 'POST', url: '/api/aieq/team-feedback', headers: auth, payload })
      expect(res.statusCode, JSON.stringify(payload)).toBe(400)
    }
    expect(recordTeamFeedback).not.toHaveBeenCalled()
  })

  it('needs a LINE identity and stops scripted floods', async () => {
    const server = await app()
    const anon = await server.inject({ method: 'POST', url: '/api/aieq/team-feedback', payload: { spot: 'intro', verdict: 'good' } })
    expect(anon.statusCode).toBe(401)
    let last = 200
    for (let i = 0; i < 31; i++) {
      last = (await server.inject({ method: 'POST', url: '/api/aieq/team-feedback', headers: auth, payload: { spot: 'intro', verdict: 'good' } })).statusCode
    }
    expect(last).toBe(429)
    expect(recordTeamFeedback).toHaveBeenCalledTimes(30)
  })

  it('tells a reporter what they already said per screen', async () => {
    const server = await app()
    const res = await server.inject({ url: '/api/aieq/team-feedback/mine', headers: auth })
    expect(res.json()).toEqual({ spots: { intro: { verdict: 'good', comment: null } } })
    expect(listMyTeamFeedback).toHaveBeenCalledWith(7)
  })
})

describe('team feedback read-out', () => {
  it('is only for the allow-listed organiser, and only while the flag is on', async () => {
    const server = await app()
    const tester = await server.inject({ url: '/api/aieq/team-feedback/summary', headers: auth })
    expect(tester.statusCode).toBe(403)
    const organiser = await server.inject({ url: '/api/aieq/team-feedback/summary?limit=5000', headers: { authorization: 'Bearer organiser' } })
    expect(organiser.statusCode).toBe(200)
    expect(organiser.json()).toMatchObject({ total: 1, reporters: 1, limit: 1000 })
    config.aieqTeamFeedback = false
    expect((await server.inject({ url: '/api/aieq/team-feedback/summary', headers: { authorization: 'Bearer organiser' } })).statusCode).toBe(404)
  })
})

