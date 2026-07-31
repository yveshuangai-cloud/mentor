import Fastify from 'fastify'
import cors from '@fastify/cors'
import { config, warnMissingConfig } from './config.js'
import { autoMigrate } from './db/index.js'
import { webhookRoutes } from './routes/webhook.js'
import { adminRoutes } from './routes/admin.js'
import { paymentRoutes } from './routes/payments.js'
import { expireSweep } from './modules/points.js'

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

  // 每小時掃一次到期點數（正式部署換 node-cron / 外部 scheduler）
  setInterval(() => {
    void expireSweep(log).catch((err) => app.log.error({ err }, 'expireSweep failed'))
  }, 60 * 60 * 1000)

  await app.listen({ port: config.port, host: '0.0.0.0' })
  log(`manman-platform backend up on :${config.port}`)
}

bootstrap().catch((err) => {
  console.error('bootstrap failed', err)
  process.exit(1)
})
