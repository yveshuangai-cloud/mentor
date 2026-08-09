import Fastify from 'fastify'
import websocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config, warnMissingConfig } from './config.js'
import { autoMigrate } from './db/index.js'
import { voiceConfigured } from './modules/voice.js'
import { voiceCallRoutes } from './routes/voiceCall.js'

async function bootstrap(): Promise<void> {
  const app = Fastify({
    logger: true,
    requestTimeout: 0,
  })
  const log = (message: string) => app.log.info(message)
  warnMissingConfig(log)
  await autoMigrate(log)

  await app.register(websocket, {
    options: {
      maxPayload: 256 * 1024,
      perMessageDeflate: false,
    },
  })
  await app.register(voiceCallRoutes, { prefix: '/api/voice-call' })

  app.get('/health', async () => ({
    ok: true,
    service: 'mantou-voice',
    configured: {
      liff: config.liffId !== 'not-configured' && config.lineLoginChannelId !== 'not-configured',
      stt: config.deepgramApiKey !== 'not-configured',
      tts: voiceConfigured(),
    },
    ts: new Date().toISOString(),
  }))

  const frontendRoot = join(dirname(fileURLToPath(import.meta.url)), '../../voice-call/frontend/dist')
  await app.register(fastifyStatic, { root: frontendRoot })
  app.setNotFoundHandler((_request, reply) => reply.sendFile('index.html'))

  await app.listen({ port: config.port, host: '0.0.0.0' })
  log(`mantou-voice up on :${config.port}`)
}

bootstrap().catch((error) => {
  console.error('mantou-voice bootstrap failed', error)
  process.exit(1)
})
