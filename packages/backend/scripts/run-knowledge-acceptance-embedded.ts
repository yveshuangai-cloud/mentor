import EmbeddedPostgres from 'embedded-postgres'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.unref()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('knowledge_acceptance_port_resolution_failed')))
        return
      }
      server.close(() => resolve(address.port))
    })
  })
}

async function main(): Promise<void> {
  const port = await availablePort()
  const dataDir = mkdtempSync(join(tmpdir(), 'mantou-knowledge-pg-'))
  const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'mantou', password: 'knowledge', port, persistent: false })
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('mantou_knowledge')

  const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const tsxCli = join(backendDir, '../../node_modules/tsx/dist/cli.mjs')
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'scripts/knowledge-acceptance.ts'], {
      cwd: backendDir,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DATABASE_URL: `postgres://mantou:knowledge@127.0.0.1:${port}/mantou_knowledge`,
        GEMINI_API_KEY: 'not-configured',
        LINE_CHANNEL_TOKEN: 'not-configured',
      },
      stdio: 'inherit',
    })
    child.once('exit', (value) => resolve(value ?? 1))
  })

  await pg.stop()
  process.exit(code)
}

main().catch((error) => {
  console.error('embedded knowledge acceptance failed:', error)
  process.exit(1)
})
