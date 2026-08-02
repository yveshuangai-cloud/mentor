import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, warnMissingConfig } from './config.js'
import { autoMigrate } from './db/index.js'
import { webhookRoutes } from './routes/webhook.js'
import { adminRoutes } from './routes/admin.js'
import { paymentRoutes } from './routes/payments.js'
import { expireSweep } from './modules/points.js'
import { runNightlyMemory } from './modules/memory/nightly.js'
import { fireDuePromises } from './modules/proactive/promises.js'
import { runNightlySoul } from './modules/proactive/nightlife.js'
import { nightlyHonestyReflection } from './modules/mirror.js'

async function bootstrap(): Promise<void> {
  const app = Fastify({ logger: true })
  const log = (msg: string) => app.log.info(msg)

  warnMissingConfig(log)
  await autoMigrate(log)

  await app.register(cors, { origin: false }) // 後台 UI 上線時再開白名單
  await app.register(webhookRoutes, { prefix: '/api/webhook' })
  await app.register(adminRoutes, { prefix: '/api/admin' })
  await app.register(paymentRoutes, { prefix: '/api/payments' })

  app.get('/health', async () => ({ ok: true, service: 'manman-platform', ts: new Date().toISOString() }))

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
    const soul = await runNightlySoul(log) // 日記→夢（記憶整理後，她才帶著整理過的默契入睡）
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

  // 本地開發才用計時器；Cloud Run request-based billing 下閒置實例會被回收，計時器不可靠
  if (config.nodeEnv === 'development') {
    setInterval(() => {
      void expireSweep(log).catch((err) => app.log.error({ err }, 'expireSweep failed'))
    }, 60 * 60 * 1000)
  }

  await app.listen({ port: config.port, host: '0.0.0.0' })
  log(`manman-platform backend up on :${config.port}`)
}

bootstrap().catch((err) => {
  console.error('bootstrap failed', err)
  process.exit(1)
})
