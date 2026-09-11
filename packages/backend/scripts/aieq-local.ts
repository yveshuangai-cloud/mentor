import EmbeddedPostgres from 'embedded-postgres'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no_available_port'))
      server.close(() => resolve(address.port))
    })
  })
}

const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
const databaseDir = mkdtempSync(join(tmpdir(), 'aieq-local-pg-'))
const databasePort = await availablePort()
const appPort = Number(process.env.PORT || 3777)
const postgres = new EmbeddedPostgres({
  databaseDir,
  port: databasePort,
  user: 'aieq',
  password: 'local-demo',
  persistent: false,
})

await postgres.initialise()
await postgres.start()
await postgres.createDatabase('aieq_local')

const tsxCli = join(backendDir, 'node_modules/tsx/dist/cli.mjs')
const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
  cwd: backendDir,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    AIEQ_DEMO_MODE: 'true',
    DATABASE_URL: `postgres://aieq:local-demo@127.0.0.1:${databasePort}/aieq_local`,
    PUBLIC_BASE_URL: `http://localhost:${appPort}`,
    PORT: String(appPort),
  },
  stdio: 'inherit',
})

console.log(`\nAIEQ 本機實機驗證： http://localhost:${appPort}/aieq`)
console.log('按 Ctrl+C 關閉；測試資料會隨暫存資料庫一併清除。\n')

let stopping = false
async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  child.kill('SIGTERM')
  await postgres.stop().catch(() => {})
  process.exit(0)
}

process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
child.on('exit', async (code) => {
  if (stopping) return
  await postgres.stop().catch(() => {})
  process.exit(code ?? 1)
})
