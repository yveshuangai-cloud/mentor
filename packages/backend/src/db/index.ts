import pg from 'pg'
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { config } from '../config.js'

const { Pool } = pg

export const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: config.dbSsl ? { rejectUnauthorized: false } : undefined,
  max: 10,
})

/**
 * 平台層查詢（users / tenants / point_rules / payments / admins…）。
 * ⚠️ 租戶層資料表（conversations、learned_facts…）禁止用這個裸查——
 * 一律走 tenantDb.ts 的 forTenant()，那裡會強制 tenant_id。
 */
export async function platformQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params?: unknown[],
): Promise<pg.QueryResult<T>> {
  return pool.query<T>(text, params as never)
}

/** 交易 helper */
export async function withTransaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 開機自動建表 + 跑 migrations + seed（沿用本尊模式，冪等） */
export async function autoMigrate(log: (msg: string) => void): Promise<void> {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`)

  const schemaSql = await readFile(join(__dirname, 'schema.sql'), 'utf8')
  await pool.query(schemaSql)

  const migrationsDir = join(__dirname, 'migrations')
  let files: string[] = []
  try {
    files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort()
  } catch {
    // 還沒有 migrations 目錄，跳過
  }
  for (const file of files) {
    const done = await pool.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [file])
    if (done.rowCount) continue
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    await pool.query(sql)
    await pool.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file])
    log(`migration applied: ${file}`)
  }

  const seedSql = await readFile(join(__dirname, 'seed.sql'), 'utf8')
  await pool.query(seedSql)
  log('db ready (schema + migrations + seed)')
}
