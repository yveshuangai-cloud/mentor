import { randomUUID } from 'node:crypto'
import { Storage } from '@google-cloud/storage'
import { config, isSoulAuthorizedLineUser } from '../config.js'
import { platformQuery, withTransaction } from '../db/index.js'
import { forTenant } from '../db/tenantDb.js'
import { extractDocument, documentSupport, fileExtension, prepareDocumentChunks } from './documents.js'
import { pushText } from './line.js'
import { resolveMembership } from './tenancy.js'
import type { AieqIdentity } from './aieq/auth.js'

const storage = new Storage()
const SIGNED_UPLOAD_TTL_MS = 15 * 60 * 1000
const MAX_ATTEMPTS = 5

export const KNOWLEDGE_TYPES = ['reference', 'policy', 'biography', 'skill_source'] as const
export const RETENTION_POLICIES = ['30_days', '90_days', 'permanent'] as const
export const KNOWLEDGE_VISIBILITIES = ['private', 'family_shared'] as const

export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number]
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number]
export type KnowledgeVisibility = (typeof KNOWLEDGE_VISIBILITIES)[number]

export interface KnowledgeUploadInput {
  fileName: string
  mimeType?: string
  sizeBytes: number
  knowledgeType?: string
  retentionPolicy?: string
  visibility?: string
}

export interface KnowledgeActor {
  userId: number
  lineUserId: string
  tenantId: number
  displayName?: string
}

export function validateKnowledgeUpload(input: KnowledgeUploadInput): {
  fileName: string
  mimeType: string
  sizeBytes: number
  knowledgeType: KnowledgeType
  retentionPolicy: RetentionPolicy
  visibility: KnowledgeVisibility
} {
  const fileName = input.fileName?.trim()
  if (!fileName || fileName.length > 255 || /[\u0000-\u001f]/.test(fileName)) throw new Error('invalid_file_name')
  if (documentSupport(fileName) !== 'supported') throw new Error('unsupported_document_type')
  const sizeBytes = Number(input.sizeBytes)
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) throw new Error('invalid_file_size')
  if (sizeBytes > config.knowledgeMaxUploadBytes) throw new Error('file_too_large')
  const knowledgeType = (input.knowledgeType ?? 'reference') as KnowledgeType
  const retentionPolicy = (input.retentionPolicy ?? 'permanent') as RetentionPolicy
  const visibility = (input.visibility ?? 'private') as KnowledgeVisibility
  if (!KNOWLEDGE_TYPES.includes(knowledgeType)) throw new Error('invalid_knowledge_type')
  if (!RETENTION_POLICIES.includes(retentionPolicy)) throw new Error('invalid_retention_policy')
  if (!KNOWLEDGE_VISIBILITIES.includes(visibility)) throw new Error('invalid_visibility')
  const mimeType = input.mimeType?.trim().slice(0, 150) || 'application/octet-stream'
  return { fileName, mimeType, sizeBytes, knowledgeType, retentionPolicy, visibility }
}

export async function authorizeKnowledgeActor(identity: AieqIdentity): Promise<KnowledgeActor> {
  if (!isSoulAuthorizedLineUser(identity.lineUserId)) throw new Error('knowledge_forbidden')
  const user = await platformQuery<{ can_shape_soul: boolean }>(
    `UPDATE users SET can_shape_soul = TRUE, updated_at = now()
     WHERE id = $1 RETURNING can_shape_soul`,
    [identity.userId],
  )
  if (!user.rows[0]?.can_shape_soul) throw new Error('knowledge_forbidden')
  const membership = await resolveMembership(identity.userId)
  if (!membership || membership.member.status !== 'confirmed' || membership.tenant.status !== 'active') {
    throw new Error('knowledge_membership_required')
  }
  return {
    userId: identity.userId,
    lineUserId: identity.lineUserId,
    tenantId: membership.tenant.id,
    displayName: identity.displayName,
  }
}

function safeObjectName(fileName: string): string {
  const ext = fileExtension(fileName)
  const stem = fileName.slice(0, ext ? -(ext.length + 1) : undefined)
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'document'
  return `${stem}${ext ? `.${ext}` : ''}`
}

function expirySql(policy: RetentionPolicy): string {
  if (policy === '30_days') return "now() + INTERVAL '30 days'"
  if (policy === '90_days') return "now() + INTERVAL '90 days'"
  return 'NULL'
}

export async function beginKnowledgeUpload(actor: KnowledgeActor, raw: KnowledgeUploadInput): Promise<{
  documentId: number
  uploadUrl: string
  expiresAt: string
}> {
  const input = validateKnowledgeUpload(raw)
  const objectName = `${actor.tenantId}/${actor.userId}/${randomUUID()}/${safeObjectName(input.fileName)}`
  const db = forTenant(actor.tenantId)
  const document = await db.query<{ id: number }>(
    `INSERT INTO uploaded_documents
       (tenant_id, user_id, file_name, file_type, extracted_text, content_sha256, truncated,
        visibility, expires_at, source, status, knowledge_type, retention_policy, mime_type,
        original_size_bytes, gcs_bucket, gcs_object)
     VALUES ($1, $2, $3, $4, NULL, NULL, FALSE, $5, ${expirySql(input.retentionPolicy)},
             'portal', 'uploading', $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [actor.userId, input.fileName, fileExtension(input.fileName), input.visibility, input.knowledgeType,
      input.retentionPolicy, input.mimeType, input.sizeBytes, config.knowledgeBucket, objectName],
  )
  const expires = Date.now() + SIGNED_UPLOAD_TTL_MS
  try {
    const [uploadUrl] = await storage.bucket(config.knowledgeBucket).file(objectName).getSignedUrl({
      version: 'v4',
      action: 'write',
      expires,
      contentType: input.mimeType,
    })
    return { documentId: document.rows[0].id, uploadUrl, expiresAt: new Date(expires).toISOString() }
  } catch (error) {
    await db.query(
      `UPDATE uploaded_documents SET status = 'failed', processing_error = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [document.rows[0].id, `signed_url_failed: ${(error as Error).message}`.slice(0, 1000)],
    )
    throw error
  }
}

export async function completeKnowledgeUpload(actor: KnowledgeActor, documentId: number): Promise<void> {
  const db = forTenant(actor.tenantId)
  const result = await db.query<{
    gcs_bucket: string | null
    gcs_object: string | null
    original_size_bytes: number | null
    status: string
  }>(
    `SELECT gcs_bucket, gcs_object, original_size_bytes, status FROM uploaded_documents
     WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
    [documentId, actor.userId],
  )
  const document = result.rows[0]
  if (!document) throw new Error('knowledge_document_not_found')
  if (document.status !== 'uploading') throw new Error('knowledge_upload_already_completed')
  if (!document.gcs_bucket || !document.gcs_object) throw new Error('knowledge_object_missing')
  const file = storage.bucket(document.gcs_bucket).file(document.gcs_object)
  const [metadata] = await file.getMetadata()
  const actualSize = Number(metadata.size ?? 0)
  if (!actualSize || actualSize > config.knowledgeMaxUploadBytes || actualSize !== Number(document.original_size_bytes)) {
    await file.delete({ ignoreNotFound: true })
    await db.query(
      `UPDATE uploaded_documents SET status = 'failed', processing_error = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [documentId, 'uploaded_size_mismatch'],
    )
    throw new Error('uploaded_size_mismatch')
  }
  await db.withTransaction(async (q) => {
    await q(
      `UPDATE uploaded_documents SET status = 'queued', gcs_generation = $3, updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [documentId, String(metadata.generation ?? '')],
    )
    await q(
      `INSERT INTO knowledge_ingest_jobs (tenant_id, user_id, document_id)
       VALUES ($1, $2, $3) ON CONFLICT (document_id) DO NOTHING`,
      [actor.userId, documentId],
    )
  })
}

export async function listKnowledgeDocuments(actor: KnowledgeActor): Promise<Record<string, unknown>[]> {
  const db = forTenant(actor.tenantId)
  const result = await db.query(
    `SELECT id, file_name, file_type, mime_type, original_size_bytes, status, knowledge_type,
            retention_policy, visibility, truncated, processing_error, duplicate_of_document_id,
            created_at, updated_at, processed_at,
            (SELECT COUNT(*)::int FROM document_chunks c
             WHERE c.tenant_id = $1 AND c.document_id = uploaded_documents.id) AS chunk_count
     FROM uploaded_documents
     WHERE tenant_id = $1 AND user_id = $2 AND source = 'portal' AND status <> 'archived'
     ORDER BY created_at DESC LIMIT 200`,
    [actor.userId],
  )
  return result.rows
}

export async function deleteKnowledgeDocument(actor: KnowledgeActor, documentId: number): Promise<void> {
  const db = forTenant(actor.tenantId)
  const result = await db.query<{ gcs_bucket: string | null; gcs_object: string | null }>(
    `SELECT gcs_bucket, gcs_object FROM uploaded_documents
     WHERE tenant_id = $1 AND id = $2 AND user_id = $3 AND source = 'portal'`,
    [documentId, actor.userId],
  )
  const document = result.rows[0]
  if (!document) throw new Error('knowledge_document_not_found')
  if (document.gcs_bucket && document.gcs_object) {
    await storage.bucket(document.gcs_bucket).file(document.gcs_object).delete({ ignoreNotFound: true })
  }
  await db.query(
    'DELETE FROM uploaded_documents WHERE tenant_id = $1 AND id = $2 AND user_id = $3',
    [documentId, actor.userId],
  )
}

interface ClaimedJob {
  id: number
  tenant_id: number
  user_id: number
  document_id: number
  attempts: number
}

async function claimJobs(limit: number): Promise<ClaimedJob[]> {
  return withTransaction(async (client) => {
    const due = await client.query<ClaimedJob>(
      `SELECT id, tenant_id, user_id, document_id, attempts
       FROM knowledge_ingest_jobs
       WHERE (status IN ('pending', 'retry') AND next_attempt_at <= now())
          OR (status = 'processing' AND locked_at < now() - INTERVAL '15 minutes')
       ORDER BY created_at ASC FOR UPDATE SKIP LOCKED LIMIT $1`,
      [limit],
    )
    if (!due.rows.length) return []
    const ids = due.rows.map((row) => row.id)
    await client.query(
      `UPDATE knowledge_ingest_jobs
       SET status = 'processing', attempts = attempts + 1, locked_at = now(), updated_at = now()
       WHERE id = ANY($1::bigint[])`,
      [ids],
    )
    return due.rows.map((row) => ({ ...row, attempts: row.attempts + 1 }))
  })
}

async function notifyUser(userId: number, text: string): Promise<void> {
  const result = await platformQuery<{ line_user_id: string }>('SELECT line_user_id FROM users WHERE id = $1', [userId])
  const lineUserId = result.rows[0]?.line_user_id
  if (lineUserId) await pushText(lineUserId, [text]).catch(() => undefined)
}

async function processJob(job: ClaimedJob): Promise<void> {
  const db = forTenant(job.tenant_id)
  const documentResult = await db.query<{
    id: number
    file_name: string
    gcs_bucket: string | null
    gcs_object: string | null
    visibility: KnowledgeVisibility
    retention_policy: RetentionPolicy
  }>(
    `SELECT id, file_name, gcs_bucket, gcs_object, visibility, retention_policy
     FROM uploaded_documents WHERE tenant_id = $1 AND id = $2 AND user_id = $3`,
    [job.document_id, job.user_id],
  )
  const stored = documentResult.rows[0]
  if (!stored?.gcs_bucket || !stored.gcs_object) throw new Error('knowledge_object_missing')
  await db.query(
    `UPDATE uploaded_documents SET status = 'processing', processing_error = NULL, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [job.document_id],
  )
  const [buffer] = await storage.bucket(stored.gcs_bucket).file(stored.gcs_object).download()
  if (buffer.byteLength > config.knowledgeMaxUploadBytes) throw new Error('file_too_large')
  const extracted = await extractDocument(buffer, stored.file_name)
  const duplicate = await db.query<{ id: number }>(
    `SELECT id FROM uploaded_documents
     WHERE tenant_id = $1 AND user_id = $2 AND visibility = $3 AND content_sha256 = $4
       AND id <> $5 AND status = 'ready' LIMIT 1`,
    [job.user_id, stored.visibility, extracted.sha256, job.document_id],
  )
  if (duplicate.rows[0]) {
    await storage.bucket(stored.gcs_bucket).file(stored.gcs_object).delete({ ignoreNotFound: true })
    await db.query(
      `UPDATE uploaded_documents
       SET status = 'duplicate', duplicate_of_document_id = $3, gcs_bucket = NULL, gcs_object = NULL,
           processed_at = now(), updated_at = now()
       WHERE tenant_id = $1 AND id = $2`,
      [job.document_id, duplicate.rows[0].id],
    )
    await notifyUser(job.user_id, `《${stored.file_name}》和知識庫裡既有文件內容相同，我已自動去重，不會重複記一份。`)
    return
  }
  const prepared = await prepareDocumentChunks(extracted)
  await db.withTransaction(async (q) => {
    await q('DELETE FROM document_chunks WHERE tenant_id = $1 AND document_id = $2', [job.document_id])
    await q(
      `UPDATE uploaded_documents
       SET extracted_text = $3, content_sha256 = $4, truncated = $5, status = 'ready',
           parser_name = 'mantou-native', parser_version = '1', embedding_model = 'gemini-embedding-2:768',
           processed_at = now(), updated_at = now(), processing_error = NULL
       WHERE tenant_id = $1 AND id = $2`,
      [job.document_id, extracted.text, extracted.sha256, extracted.truncated],
    )
    for (let index = 0; index < prepared.chunks.length; index++) {
      await q(
        `INSERT INTO document_chunks
           (tenant_id, user_id, document_id, visibility, chunk_index, citation, content, embedding)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [job.user_id, job.document_id, stored.visibility, index,
          `【${stored.file_name}，段落 ${index + 1}】`, prepared.chunks[index], prepared.vectors[index] ?? null],
      )
    }
  })
  const warning = extracted.truncated ? '；內容超過第一階段上限，已保留開頭與結尾並標記待升級解析' : ''
  await notifyUser(job.user_id, `《${stored.file_name}》已吸收完成，共整理成 ${prepared.chunks.length} 個知識片段${warning}。你現在可以直接問我這份文件的內容。`)
}

async function failJob(job: ClaimedJob, error: Error): Promise<void> {
  const dead = job.attempts >= MAX_ATTEMPTS
  const delayMinutes = Math.min(30, 2 ** Math.max(0, job.attempts - 1))
  await platformQuery(
    `UPDATE knowledge_ingest_jobs
     SET status = $2, last_error = $3, next_attempt_at = now() + ($4 * INTERVAL '1 minute'),
         locked_at = NULL, updated_at = now()
     WHERE id = $1`,
    [job.id, dead ? 'dead' : 'retry', error.message.slice(0, 1000), delayMinutes],
  )
  const db = forTenant(job.tenant_id)
  await db.query(
    `UPDATE uploaded_documents SET status = $3, processing_error = $4, updated_at = now()
     WHERE tenant_id = $1 AND id = $2`,
    [job.document_id, dead ? 'failed' : 'queued', error.message.slice(0, 1000)],
  )
  if (dead) await notifyUser(job.user_id, '這份文件暫時沒能安全吸收。我已保留原始檔與錯誤紀錄，請讓威廷查看知識庫處理狀態。')
}

export async function processKnowledgeIngestJobs(limit = 3): Promise<{ claimed: number; processed: number; failed: number }> {
  const jobs = await claimJobs(Math.max(1, Math.min(20, limit)))
  let processed = 0
  let failed = 0
  for (const job of jobs) {
    try {
      await processJob(job)
      await platformQuery(
        `UPDATE knowledge_ingest_jobs SET status = 'done', locked_at = NULL, updated_at = now() WHERE id = $1`,
        [job.id],
      )
      processed++
    } catch (error) {
      failed++
      await failJob(job, error as Error)
    }
  }
  return { claimed: jobs.length, processed, failed }
}
