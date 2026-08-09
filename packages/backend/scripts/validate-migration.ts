import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import pg from 'pg'

const file = process.argv[2]
if (!file || !process.env.DATABASE_URL) {
  throw new Error('Usage: DATABASE_URL=... tsx scripts/validate-migration.ts <migration.sql>')
}

const client = new pg.Client({ connectionString: process.env.DATABASE_URL })
await client.connect()
try {
  await client.query('BEGIN')
  await client.query(await readFile(resolve(file), 'utf8'))
  const audit = await client.query<{
    affected_facts: number
    affected_vectors: number
    affected_conversations: number
  }>(
    `SELECT affected_facts, affected_vectors, affected_conversations
     FROM memory_repair_audit WHERE repair_key = '009-mantou-old-identity'`,
  )
  console.log(JSON.stringify({ transaction: 'validated-and-rolled-back', audit: audit.rows[0] ?? null }))
  await client.query('ROLLBACK')
} catch (error) {
  await client.query('ROLLBACK').catch(() => {})
  throw error
} finally {
  await client.end()
}
