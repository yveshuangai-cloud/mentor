import type { FastifyInstance, FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { bearerToken, verifyLiffIdToken } from '../modules/aieq/auth.js'
import {
  authorizeKnowledgeActor,
  beginKnowledgeUpload,
  completeKnowledgeUpload,
  deleteKnowledgeDocument,
  listKnowledgeDocuments,
  processKnowledgeIngestJobs,
  type KnowledgeActor,
  type KnowledgeUploadInput,
} from '../modules/knowledge.js'

async function actorFromRequest(req: FastifyRequest): Promise<KnowledgeActor> {
  const token = bearerToken(req.headers.authorization)
  return authorizeKnowledgeActor(await verifyLiffIdToken(token))
}

function errorStatus(error: Error): number {
  if (/bearer|line_id_token|line_login|expired/.test(error.message)) return 401
  if (/forbidden|membership/.test(error.message)) return 403
  if (/not_found/.test(error.message)) return 404
  if (/invalid|unsupported|too_large|mismatch|already_completed/.test(error.message)) return 400
  return 500
}

export async function knowledgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/bootstrap', async () => ({
    liffId: config.knowledgeLiffId,
    maxUploadBytes: config.knowledgeMaxUploadBytes,
  }))

  app.get('/documents', async (req, reply) => {
    try {
      return { documents: await listKnowledgeDocuments(await actorFromRequest(req)) }
    } catch (error) {
      return reply.code(errorStatus(error as Error)).send({ error: (error as Error).message })
    }
  })

  app.post<{ Body: KnowledgeUploadInput }>('/uploads', async (req, reply) => {
    try {
      return await beginKnowledgeUpload(await actorFromRequest(req), req.body ?? ({} as KnowledgeUploadInput))
    } catch (error) {
      app.log.warn({ err: error }, 'knowledge upload start failed')
      return reply.code(errorStatus(error as Error)).send({ error: (error as Error).message })
    }
  })

  app.post<{ Params: { documentId: string } }>('/uploads/:documentId/complete', async (req, reply) => {
    try {
      const actor = await actorFromRequest(req)
      const documentId = Number(req.params.documentId)
      if (!Number.isSafeInteger(documentId) || documentId <= 0) throw new Error('invalid_document_id')
      await completeKnowledgeUpload(actor, documentId)
      // Low-latency best effort. The durable minute scheduler is the source of reliability.
      setImmediate(() => void processKnowledgeIngestJobs(1).catch((err) => app.log.error({ err }, 'knowledge kick failed')))
      return reply.code(202).send({ ok: true, status: 'queued' })
    } catch (error) {
      app.log.warn({ err: error }, 'knowledge upload completion failed')
      return reply.code(errorStatus(error as Error)).send({ error: (error as Error).message })
    }
  })

  app.delete<{ Params: { documentId: string } }>('/documents/:documentId', async (req, reply) => {
    try {
      const documentId = Number(req.params.documentId)
      if (!Number.isSafeInteger(documentId) || documentId <= 0) throw new Error('invalid_document_id')
      await deleteKnowledgeDocument(await actorFromRequest(req), documentId)
      return { ok: true }
    } catch (error) {
      app.log.warn({ err: error }, 'knowledge delete failed')
      return reply.code(errorStatus(error as Error)).send({ error: (error as Error).message })
    }
  })
}
