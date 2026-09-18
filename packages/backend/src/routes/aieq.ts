import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { questionsFor } from '../modules/aieq/questions.js'
import { animalForCode } from '../modules/aieq/catalog.js'
import { bearerToken, verifyLiffIdToken, type AieqIdentity } from '../modules/aieq/auth.js'
import {
  appendEvent,
  claimFriendInvite,
  confirmProfile,
  createFriendInvite,
  deleteAieqData,
  findCurrentSession,
  findOrCreateSession,
  getConfirmedProfileSession,
  getFunnelStats,
  getProfile,
  getSession,
  listFriends,
  listFriendsOfFriends,
  setProfileVisibility,
} from '../modules/aieq/repository.js'
import { buildShareInviteFlex } from '../modules/aieq/flex.js'
import { listMyTeamFeedback, recordTeamFeedback, TEAM_FEEDBACK_SPOT, TEAM_FEEDBACK_VERDICTS } from '../modules/aieq/teamFeedback.js'
import { allow } from '../modules/aieq/rateLimit.js'
import { buildResultReport } from '../modules/aieq/report.js'
import { scoreAssessment } from '../modules/aieq/scoring.js'

const eventSchema = z.object({
  eventId: z.string().min(1).max(200),
  source: z.enum(['card', 'free_text', 'system']),
  kind: z.enum(['answer', 'uncertain', 'skip', 'back', 'pause', 'resume']),
  questionId: z.string().optional(),
  optionId: z.string().optional(),
  rawText: z.string().max(2000).optional(),
  interpretationConfidence: z.number().min(0).max(1).optional(),
  occurredAt: z.string().datetime().optional(),
})

const teamFeedbackSchema = z.object({
  spot: z.string().regex(TEAM_FEEDBACK_SPOT),
  verdict: z.enum(TEAM_FEEDBACK_VERDICTS),
  comment: z.string().max(1000).optional(),
  typeCode: z.string().regex(/^[EI][SN][TF][JP]$/).optional(),
  sessionId: z.string().max(80).optional(),
})

async function identity(req: FastifyRequest): Promise<AieqIdentity> {
  return verifyLiffIdToken(bearerToken(req.headers.authorization))
}

const adminLineUserIds = new Set(config.aieqAdminLineUserIds.split(',').map((id) => id.trim()).filter(Boolean))
const isAieqAdmin = (who: AieqIdentity) => adminLineUserIds.has(who.lineUserId)

// Per-user ceilings far above human pace; they exist to stop scripts, not players.
function limited(reply: FastifyReply, key: string, limit: number, windowMs: number): boolean {
  if (allow(key, limit, windowMs)) return false
  void reply.code(429).send({ error: 'too_many_requests' })
  return true
}

function present(session: Awaited<ReturnType<typeof findOrCreateSession>>) {
  const questions = questionsFor(session.instrumentVersion)
  const question = questions[session.currentQuestionIndex] ?? null
  const result = session.status === 'completed' ? scoreAssessment(session, questions) : null
  return {
    session: {
      id: session.id,
      status: session.status,
      currentQuestionIndex: session.currentQuestionIndex,
      totalQuestions: questions.length,
      personalizationConsent: session.personalizationConsent,
    },
    question,
    result: result ? { ...result, report: buildResultReport(result), animal: animalForCode(result.preferenceCode) } : null,
  }
}

export async function aieqRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async () => ({
    liffId: config.liffId,
    oaBasicId: config.lineOaBasicId,
    demoMode: config.nodeEnv !== 'production' && config.aieqDemoMode,
    teamFeedback: config.aieqTeamFeedback,
  }))

  app.get('/entry', async (req, reply) => {
    try {
      const who = await identity(req)
      const profile = await getProfile(who.userId)
      const confirmed = profile ? await getConfirmedProfileSession(who.userId) : null
      if (confirmed) return { mode: 'result', profile, ...present(confirmed) }

      let active = await findCurrentSession(who.userId)
      if (active?.status === 'paused') {
        active = (await appendEvent(who.userId, {
          eventId: `liff-resume:${active.id}:${Date.now()}`,
          sessionId: active.id,
          source: 'system',
          kind: 'resume',
          occurredAt: new Date().toISOString(),
        })).session
      }
      if (active) return { mode: 'assessment', profile: null, ...present(active) }
      return { mode: 'intro', profile: null, session: null, question: null, result: null }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/sessions', async (req, reply) => {
    try {
      const who = await identity(req)
      if (limited(reply, `sessions:${who.userId}`, 20, 60_000)) return
      const confirmed = await getConfirmedProfileSession(who.userId)
      if (confirmed) return { mode: 'result', profile: await getProfile(who.userId), ...present(confirmed) }
      let session = await findOrCreateSession(who.userId)
      if (session.status === 'paused') {
        session = (await appendEvent(who.userId, {
          eventId: `liff-resume:${session.id}:${Date.now()}`,
          sessionId: session.id,
          source: 'system',
          kind: 'resume',
          occurredAt: new Date().toISOString(),
        })).session
      }
      return { mode: 'assessment', profile: null, ...present(session) }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.get('/sessions/:id', async (req, reply) => {
    try {
      const who = await identity(req)
      const session = await getSession(who.userId, (req.params as { id: string }).id)
      return session ? present(session) : reply.code(404).send({ error: 'session_not_found' })
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/sessions/:id/events', async (req, reply) => {
    try {
      const who = await identity(req)
      if (limited(reply, `events:${who.userId}`, 60, 60_000)) return
      const parsed = eventSchema.parse(req.body)
      const transition = await appendEvent(who.userId, {
        ...parsed,
        sessionId: (req.params as { id: string }).id,
        occurredAt: parsed.occurredAt ?? new Date().toISOString(),
      })
      if (!transition.accepted) return reply.code(409).send({ error: transition.reason, ...present(transition.session) })
      return { duplicate: transition.duplicate, ...present(transition.session) }
    } catch (error) {
      const message = error instanceof z.ZodError ? 'invalid_event' : (error as Error).message
      return reply.code(message.includes('token') ? 401 : 400).send({ error: message })
    }
  })

  app.post('/sessions/:id/confirm', async (req, reply) => {
    try {
      const who = await identity(req)
      const body = z.object({ visibleToFriends: z.boolean(), personalizationConsent: z.boolean() }).parse(req.body)
      await confirmProfile(who.userId, (req.params as { id: string }).id, body)
      return { ok: true, profile: await getProfile(who.userId) }
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message })
    }
  })

  app.get('/me', async (req, reply) => {
    try {
      const who = await identity(req)
      return { identity: who, profile: await getProfile(who.userId), isAdmin: isAieqAdmin(who) }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.delete('/me/data', async (req, reply) => {
    try {
      const who = await identity(req)
      z.object({ confirmation: z.literal('DELETE_AIEQ') }).parse(req.body)
      await deleteAieqData(who.userId)
      return { ok: true }
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message })
    }
  })

  app.get('/friends', async (req, reply) => {
    try {
      const who = await identity(req)
      const profile = await getProfile(who.userId)
      return {
        visibility: profile?.visibility ?? null,
        friends: await listFriends(who.userId),
        friendsOfFriends: await listFriendsOfFriends(who.userId),
      }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/me/visibility', async (req, reply) => {
    try {
      const who = await identity(req)
      if (limited(reply, `visibility:${who.userId}`, 30, 60_000)) return
      const { visibility } = z.object({ visibility: z.enum(['private', 'friends', 'friends_of_friends']) }).parse(req.body)
      await setProfileVisibility(who.userId, visibility)
      return { ok: true, profile: await getProfile(who.userId) }
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message })
    }
  })

  // Funnel for the people running the event: counts only. Platform admin token or an allow-listed LINE user.
  app.get('/stats', async (req, reply) => {
    const adminToken = process.env.ADMIN_TOKEN
    let allowed = Boolean(adminToken) && req.headers['x-admin-token'] === adminToken
    if (!allowed) {
      try { allowed = isAieqAdmin(await identity(req)) } catch { allowed = false }
    }
    if (!allowed) return reply.code(403).send({ error: 'forbidden' })
    return { generatedAt: new Date().toISOString(), ...(await getFunnelStats()) }
  })

  // 「團隊回報小標籤」: test environments only. Hidden (404) wherever AIEQ_TEAM_FEEDBACK is not set, i.e. production.
  app.post('/team-feedback', async (req, reply) => {
    if (!config.aieqTeamFeedback) return reply.code(404).send({ error: 'not_found' })
    try {
      const who = await identity(req)
      if (limited(reply, `team-feedback:${who.userId}`, 30, 60_000)) return
      const parsed = teamFeedbackSchema.safeParse(req.body)
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_feedback' })
      const userAgent = String(req.headers['user-agent'] ?? '')
      const saved = await recordTeamFeedback(who, { ...parsed.data, userAgent })
      return { ok: true, ...saved }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.get('/team-feedback/mine', async (req, reply) => {
    if (!config.aieqTeamFeedback) return reply.code(404).send({ error: 'not_found' })
    try {
      const who = await identity(req)
      return { spots: await listMyTeamFeedback(who.userId) }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/friend-invites', async (req, reply) => {
    try {
      const who = await identity(req)
      if (limited(reply, `invite:${who.userId}`, 20, 3_600_000)) return
      const invite = await createFriendInvite(who.userId)
      const entry = config.liffId === 'not-configured'
        ? `${config.publicBaseUrl}/aieq`
        : `https://liff.line.me/${config.liffId}`
      const url = `${entry}?invite=${invite.token}`
      const profile = await getProfile(who.userId)
      // LINE only renders Flex images served over HTTPS, so local HTTP demos keep the plain-text share.
      const shareMessage = profile && config.publicBaseUrl.startsWith('https://')
        ? buildShareInviteFlex({
          typeCode: String(profile.type_code),
          displayName: who.displayName,
          pictureUrl: who.pictureUrl,
          inviteUrl: url,
          publicBaseUrl: config.publicBaseUrl,
        })
        : null
      return { ...invite, url, shareMessage }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/friend-invites/:token/claim', async (req, reply) => {
    try {
      const who = await identity(req)
      if (limited(reply, `claim:${who.userId}`, 30, 60_000)) return
      const status = await claimFriendInvite(who.userId, (req.params as { token: string }).token)
      return { ok: true, status, friends: await listFriends(who.userId) }
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message })
    }
  })
}
