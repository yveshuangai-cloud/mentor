import type { FastifyInstance } from 'fastify'
import { mediaObject } from '../modules/voice.js'

const PREFIX_RE = /^[a-z0-9-]{1,32}$/
const FILE_RE = /^[0-9a-f-]{36}\.(?:m4a|jpg|jpeg|png)$/i

/**
 * LINE 只保存外部媒體 URL，不替 OA 永久代管音檔。
 * 這條穩定 URL 用不可猜 UUID 定位私有 GCS 物件，並支援 Range 供手機續播。
 */
export async function mediaRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:prefix/:fileName', async (req, reply) => {
    const { prefix, fileName } = req.params as { prefix: string; fileName: string }
    if (!PREFIX_RE.test(prefix) || !FILE_RE.test(fileName)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    const file = mediaObject(`${prefix}/${fileName}`)
    let metadata
    try {
      ;[metadata] = await file.getMetadata()
    } catch (error) {
      const code = Number((error as { code?: number }).code)
      if (code === 404) return reply.code(404).send({ error: 'not_found' })
      throw error
    }

    const size = Number(metadata.size ?? 0)
    const contentType = metadata.contentType || 'application/octet-stream'
    reply.header('accept-ranges', 'bytes')
    reply.header('cache-control', 'public, max-age=31536000, immutable')
    reply.header('content-type', contentType)

    const range = req.headers.range?.match(/^bytes=(\d*)-(\d*)$/)
    if (!range) {
      reply.header('content-length', String(size))
      return reply.send(file.createReadStream())
    }

    const start = range[1] ? Number(range[1]) : 0
    const end = range[2] ? Number(range[2]) : size - 1
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= size) {
      return reply.header('content-range', `bytes */${size}`).code(416).send()
    }
    reply.header('content-range', `bytes ${start}-${end}/${size}`)
    reply.header('content-length', String(end - start + 1))
    return reply.code(206).send(file.createReadStream({ start, end }))
  })
}
