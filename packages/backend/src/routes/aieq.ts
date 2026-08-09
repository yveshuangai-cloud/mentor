import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { config } from '../config.js'
import { AIEQ_QUESTIONS } from '../modules/aieq/questions.js'
import { animalForCode } from '../modules/aieq/catalog.js'
import { bearerToken, verifyLiffIdToken, type AieqIdentity } from '../modules/aieq/auth.js'
import {
  appendEvent,
  claimFriendInvite,
  confirmProfile,
  createFriendInvite,
  deleteAieqData,
  findOrCreateSession,
  getProfile,
  getSession,
  listFriends,
} from '../modules/aieq/repository.js'
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

async function identity(req: FastifyRequest): Promise<AieqIdentity> {
  return verifyLiffIdToken(bearerToken(req.headers.authorization))
}

function present(session: Awaited<ReturnType<typeof findOrCreateSession>>) {
  const question = AIEQ_QUESTIONS[session.currentQuestionIndex] ?? null
  const result = session.status === 'completed' ? scoreAssessment(session) : null
  return {
    session: {
      id: session.id,
      status: session.status,
      currentQuestionIndex: session.currentQuestionIndex,
      totalQuestions: AIEQ_QUESTIONS.length,
      personalizationConsent: session.personalizationConsent,
    },
    question,
    result: result ? { ...result, report: buildResultReport(result), animal: animalForCode(result.preferenceCode) } : null,
  }
}

export async function aieqRoutes(app: FastifyInstance): Promise<void> {
  app.get('/config', async () => ({ liffId: config.liffId }))

  app.post('/sessions', async (req, reply) => {
    try {
      const who = await identity(req)
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
      return present(session)
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
      return { identity: who, profile: await getProfile(who.userId) }
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
      return { friends: await listFriends(who.userId) }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/friend-invites', async (req, reply) => {
    try {
      const who = await identity(req)
      const invite = await createFriendInvite(who.userId)
      const entry = config.liffId === 'not-configured'
        ? `${config.publicBaseUrl}/aieq`
        : `https://liff.line.me/${config.liffId}`
      return { ...invite, url: `${entry}?invite=${invite.token}` }
    } catch (error) {
      return reply.code(401).send({ error: (error as Error).message })
    }
  })

  app.post('/friend-invites/:token/claim', async (req, reply) => {
    try {
      const who = await identity(req)
      await claimFriendInvite(who.userId, (req.params as { token: string }).token)
      return { ok: true, friends: await listFriends(who.userId) }
    } catch (error) {
      return reply.code(400).send({ error: (error as Error).message })
    }
  })
}
