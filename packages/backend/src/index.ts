import Fastify from 'fastify'
import cors from '@fastify/cors'
import fastifyStatic from '@fastify/static'
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { config, warnMissingConfig } from './config.js'
import { allow } from './modules/aieq/rateLimit.js'
import { autoMigrate } from './db/index.js'
import { processQueuedWebhookEvents, webhookRoutes } from './routes/webhook.js'
import { aieqWebhookRoutes, processAieqWebhookEvents } from './routes/aieqWebhook.js'
import { adminRoutes } from './routes/admin.js'
import { paymentRoutes } from './routes/payments.js'
import { mediaRoutes } from './routes/media.js'
import { aieqRoutes } from './routes/aieq.js'
import { expireSweep } from './modules/points.js'
import { runNightlyMemory } from './modules/memory/nightly.js'
import { fireDuePromises } from './modules/proactive/promises.js'
import { runNightlySoul } from './modules/proactive/nightlife.js'
import { runProactiveCare } from './modules/proactive/care.js'
import { nightlyHonestyReflection } from './modules/mirror.js'

async function bootstrap(): Promise<void> {
  // Railway and Cloud Run terminate TLS in front of us; without this req.ip is the proxy hop and per-IP limits scatter.
  const app = Fastify({ logger: true, trustProxy: true })
  const log = (msg: string) => app.log.info(msg)

  warnMissingConfig(log)
  await autoMigrate(log)

  await app.register(cors, { origin: false }) // 後台 UI 上線時再開白名單

  // Baseline hardening for every response. HSTS only makes sense once the public URL is HTTPS.
  const hsts = config.publicBaseUrl.startsWith('https://')
  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff')
    reply.header('referrer-policy', 'strict-origin-when-cross-origin')
    if (hsts) reply.header('strict-transport-security', 'max-age=15552000')
    const type = String(reply.getHeader('content-type') ?? '')
    if (type.startsWith('text/html')) {
      // LIFF pages open in LINE's in-app browser, never inside an iframe.
      reply.header('x-frame-options', 'DENY')
      reply.header('x-robots-tag', 'noindex')
    }
  })

  // CSP for the LIFF page, report-only until real LINE sessions prove the allow-list. Violations land in the server log.
  const liffCsp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://static.line-scdn.net https://*.line-scdn.net",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https://*.line.me https://*.line-scdn.net https://*.line-apps.com https://*.line.biz",
    "font-src 'self' data:",
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self' https://*.line.me",
    'report-uri /api/csp-report',
  ].join('; ')
  app.addContentTypeParser(['application/csp-report', 'application/reports+json'], { parseAs: 'string', bodyLimit: 16_384 }, (_req, body, done) => done(null, body))
  app.post('/api/csp-report', async (req, reply) => {
    if (!allow(`csp:${req.ip}`, 10, 60_000)) return reply.code(429).send()
    app.log.warn({ cspReport: String(req.body ?? '').slice(0, 2000), ua: req.headers['user-agent'] }, 'csp violation reported')
    return reply.code(204).send()
  })
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '../../../assets/aieq'),
    prefix: '/aieq/assets/',
    decorateReply: false,
  })
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '../../../assets/ai-personality/scenes'),
    prefix: '/aieq/scenes/',
    decorateReply: false,
  })
  await app.register(fastifyStatic, {
    root: join(dirname(fileURLToPath(import.meta.url)), '../../../output/design'),
    prefix: '/aieq/design/',
    decorateReply: false,
  })
  // An AI Personality-only account gets its own webhook at the same path; Mantou keeps the full one.
  await app.register(config.aieqOnlyWebhook ? aieqWebhookRoutes : webhookRoutes, { prefix: '/api/webhook' })
  await app.register(aieqRoutes, { prefix: '/api/aieq' })
  await app.register(adminRoutes, { prefix: '/api/admin' })
  await app.register(paymentRoutes, { prefix: '/api/payments' })
  await app.register(mediaRoutes, { prefix: '/media' })

  app.get('/health', async () => ({ ok: true, service: 'mantou-platform', ts: new Date().toISOString() }))

  // 後台 UI（單檔、免建置；權限靠 UI 內輸入的 X-Admin-Token 打 admin API）
  app.get('/admin', async (_req, reply) => {
    // An AI Personality-only deployment has nothing to administer here; do not expose the console shell at all.
    if (config.aieqOnlyWebhook) return reply.code(404).send({ error: 'not_found' })
    const html = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../public/admin.html'), 'utf8')
    return reply.type('text/html; charset=utf-8').send(html)
  })

  // The LIFF page is HTML + three static files. Their URLs carry a content hash so phones never keep a stale
  // script after a deploy, while the files themselves can be cached hard.
  const publicDir = join(dirname(fileURLToPath(import.meta.url)), '../public')
  const liffAssets: Record<string, { file: string; type: string }> = {
    '/aieq.css': { file: 'aieq.css', type: 'text/css; charset=utf-8' },
    '/aieq-core.js': { file: 'aieq-core.js', type: 'application/javascript; charset=utf-8' },
    '/aieq.js': { file: 'aieq.js', type: 'application/javascript; charset=utf-8' },
  }
  const assetHash = createHash('sha1')
  for (const asset of Object.values(liffAssets)) assetHash.update(await readFile(join(publicDir, asset.file)))
  const assetVersion = assetHash.digest('hex').slice(0, 10)
  const liffHtml = (await readFile(join(publicDir, 'aieq.html'), 'utf8')).replaceAll('__ASSET_V__', assetVersion)

  app.get('/aieq', async (_req, reply) => {
    return reply
      .header('content-security-policy-report-only', liffCsp)
      .header('cache-control', 'no-cache')
      .type('text/html; charset=utf-8')
      .send(liffHtml)
  })
  for (const [path, asset] of Object.entries(liffAssets)) {
    app.get(path, async (req, reply) => {
      const body = await readFile(join(publicDir, asset.file), 'utf8')
      const versioned = (req.query as { v?: string }).v === assetVersion
      return reply
        .header('cache-control', versioned ? 'public, max-age=31536000, immutable' : 'no-cache')
        .type(asset.type)
        .send(body)
    })
  }

  app.get('/aieq-manifest.webmanifest', async (_req, reply) => {
    const manifest = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../public/aieq-manifest.webmanifest'), 'utf8')
    return reply.type('application/manifest+json; charset=utf-8').send(manifest)
  })

  app.get('/aieq-sw.js', async (_req, reply) => {
    const worker = await readFile(join(dirname(fileURLToPath(import.meta.url)), '../public/aieq-sw.js'), 'utf8')
    return reply.header('service-worker-allowed', '/').type('application/javascript; charset=utf-8').send(worker)
  })

  // 到期點數掃描：生產走 Cloud Scheduler 打這條（throttled Cloud Run 上 setInterval 必死）
  app.post('/api/cron/expire-sweep', async (req, reply) => {
    if (!config.cronSecret || req.headers['x-cron-secret'] !== config.cronSecret) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    await expireSweep(log)
    return { ok: true }
  })

  // 夜間記憶整理（Cloud Scheduler 每晚打一次；台北深夜時段）：
  // 逐租戶：facts/convs 歸主題 → 新主題提案（冷啟動降門檻）→ 蒸餾有新料的主題 → 全域鞏固
  app.post('/api/cron/nightly-memory', async (req, reply) => {
    if (!config.cronSecret || req.headers['x-cron-secret'] !== config.cronSecret) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const memory = await runNightlyMemory(log)
    const soul = config.enableNightSoul
      ? await runNightlySoul(log)
      : { diaries: 0, dreams: 0 }
    const reflections = await nightlyHonestyReflection(log) // 誠實自省（隔天早上帶出）
    return { ok: true, ...memory, ...soul, reflections }
  })

  // 約定履約（Cloud Scheduler 每分鐘打）：到期約定 → 扣 proactive 點 → 她的聲音生成 → 主動推播
  app.post('/api/cron/fire-promises', async (req, reply) => {
    if (!config.cronSecret || req.headers['x-cron-secret'] !== config.cronSecret) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const result = await fireDuePromises(log)
    return { ok: true, ...result }
  })

  // 主動關懷（Cloud Scheduler 每 15 分打）：夢種子/太久沒見 → 護欄過了才輕輕出聲
  app.post('/api/cron/proactive-care', async (req, reply) => {
    if (!config.cronSecret || req.headers['x-cron-secret'] !== config.cronSecret) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const result = await runProactiveCare(log)
    return { ok: true, ...result }
  })

  // LINE webhook durable inbox 補處理（建議 Cloud Scheduler 每分鐘打一次）。
  app.post('/api/cron/process-webhooks', async (req, reply) => {
    if (!config.cronSecret || req.headers['x-cron-secret'] !== config.cronSecret) {
      return reply.code(401).send({ error: 'unauthorized' })
    }
    const result = config.aieqOnlyWebhook ? await processAieqWebhookEvents(app, 50) : await processQueuedWebhookEvents(app, 50)
    return { ok: true, ...result }
  })

  // 本地開發才用計時器；Cloud Run request-based billing 下閒置實例會被回收，計時器不可靠
  if (config.nodeEnv === 'development') {
    setInterval(() => {
      void expireSweep(log).catch((err) => app.log.error({ err }, 'expireSweep failed'))
    }, 60 * 60 * 1000)
  }

  await app.listen({ port: config.port, host: '0.0.0.0' })
  log(`mantou-platform backend up on :${config.port}`)
}

bootstrap().catch((err) => {
  console.error('bootstrap failed', err)
  process.exit(1)
})
