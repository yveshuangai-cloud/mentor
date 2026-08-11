/**
 * 用 embedded-postgres（真 PostgreSQL binaries）起一個拋棄式資料庫，
 * 設好 DATABASE_URL 後執行 acceptance.ts。CI／無 Docker 環境用。
 */
import EmbeddedPostgres from 'embedded-postgres'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDir = mkdtempSync(join(tmpdir(), 'mantou-acceptance-pg-'))
const pg = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: 'mantou',
  password: 'acceptance',
  port: 55432,
  persistent: false,
})

async function main(): Promise<void> {
  console.log('— 啟動拋棄式 PostgreSQL（embedded）—')
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('mantou_acceptance')

  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: 'postgres://mantou:acceptance@localhost:55432/mantou_acceptance',
    DATABASE_PUBLIC_URL: '',
    // Acceptance uses fake users and local LLM overrides. Never inherit production connectors.
    LINE_CHANNEL_TOKEN: 'not-configured',
    LINE_CHANNEL_SECRET: 'not-configured',
    BRIDGE_SECRET: '',
    ANTHROPIC_API_KEY: 'not-configured',
    GEMINI_API_KEY: 'not-configured',
    MINIMAX_API_KEY: 'not-configured',
    DEEPGRAM_API_KEY: 'not-configured',
    LIVEKIT_ENABLED: 'false',
    TURN_SHADOW_ENABLED: 'true',
  }
  const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const tsxCli = join(backendDir, '../../node_modules/tsx/dist/cli.mjs') // workspaces 提升到根
  const code: number = await new Promise((resolve) => {
    const child = spawn(process.execPath, [tsxCli, 'scripts/acceptance.ts'], {
      cwd: backendDir,
      env,
      stdio: 'inherit',
    })
    child.on('exit', (c) => resolve(c ?? 1))
  })

  await pg.stop()
  process.exit(code)
}

main().catch(async (err) => {
  console.error('embedded pg failed:', err)
  await pg.stop().catch(() => {})
  process.exit(1)
})
