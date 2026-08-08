/** 開機煙測：embedded PG → 真的 boot server → /health、/admin UI、admin 401。 */
import EmbeddedPostgres from 'embedded-postgres'
import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const dataDir = mkdtempSync(join(tmpdir(), 'mantou-smoke-pg-'))
const pg = new EmbeddedPostgres({ databaseDir: dataDir, user: 'mantou', password: 'smoke', port: 55433, persistent: false })

async function main(): Promise<void> {
  await pg.initialise()
  await pg.start()
  await pg.createDatabase('manman_smoke')

  const backendDir = join(dirname(fileURLToPath(import.meta.url)), '..')
  const tsxCli = join(backendDir, '../../node_modules/tsx/dist/cli.mjs')
  const child = spawn(process.execPath, [tsxCli, 'src/index.ts'], {
    cwd: backendDir,
    env: {
      ...process.env,
      DATABASE_URL: 'postgres://mantou:smoke@localhost:55433/mantou_smoke',
      PORT: '3777',
      ADMIN_TOKEN: 'smoke-token',
    },
    stdio: 'pipe',
  })
  child.stderr.on('data', (d: Buffer) => process.stderr.write(d))

  let ok = 0
  let failed = 0
  const check = (name: string, cond: boolean) => {
    if (cond) { ok++; console.log(`  ✅ ${name}`) } else { failed++; console.error(`  ❌ ${name}`) }
  }

  // 等 server 起來（最多 30s）
  let up = false
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch('http://localhost:3777/health')
      if (r.ok) { up = true; break }
    } catch { /* not yet */ }
    await new Promise((res) => setTimeout(res, 500))
  }
  check('server boot + /health 200（autoMigrate 全跑過）', up)

  if (up) {
    const admin = await fetch('http://localhost:3777/admin')
    const html = await admin.text()
    check('/admin 回 UI（200 + 標題）', admin.ok && html.includes('饅頭平台'))
    const noAuth = await fetch('http://localhost:3777/api/admin/point-rules')
    check('admin API 無 token → 401', noAuth.status === 401)
    const withAuth = await fetch('http://localhost:3777/api/admin/point-rules', {
      headers: { 'x-admin-token': 'smoke-token' },
    })
    const rules = (await withAuth.json()) as { rules: { gate: string }[] }
    check('admin API 帶 token → 規則表（含 seed 六閘道）', withAuth.ok && rules.rules.length >= 6)
    const cronNoAuth = await fetch('http://localhost:3777/api/cron/nightly-memory', { method: 'POST' })
    check('cron route 無 secret → 401', cronNoAuth.status === 401)
    const webhookCronNoAuth = await fetch('http://localhost:3777/api/cron/process-webhooks', { method: 'POST' })
    check('webhook 補處理 cron 無 secret → 401', webhookCronNoAuth.status === 401)
  }

  child.kill()
  await pg.stop()
  console.log(`\n═══ 煙測：${ok} 過 / ${failed} 敗 ═══`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(async (err) => {
  console.error('smoke crashed:', err)
  await pg.stop().catch(() => {})
  process.exit(1)
})
