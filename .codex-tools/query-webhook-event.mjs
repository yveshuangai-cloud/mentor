import pg from 'pg'

const eventId = process.argv[2]
if (!eventId) throw new Error('event id is required')
if (!process.env.MANTOU_DB_URL) throw new Error('MANTOU_DB_URL is required')

const source = process.env.MANTOU_DB_URL.trim()
const localSource = source.replace('@/', '@127.0.0.1:5432/')
let url
try {
  url = new URL(localSource)
} catch {
  throw new Error('DATABASE_URL format is not supported by the diagnostic script')
}
url.hostname = '127.0.0.1'
url.port = '5432'
url.searchParams.delete('host')
url.searchParams.delete('sslmode')

const client = new pg.Client({ connectionString: url.toString(), ssl: false })
try {
  await client.connect()
  const result = await client.query(
    `SELECT event_id, status, attempts, last_error, created_at, updated_at, processed_at
       FROM line_webhook_events
      WHERE event_id = $1`,
    [eventId],
  )
  const rules = await client.query(
    `SELECT gate, cost, enabled
       FROM point_rules
      WHERE gate IN ('text', 'web_search', 'voice')
      ORDER BY gate`,
  )
  const actor = await client.query(
    `SELECT u.display_name, u.can_shape_soul
       FROM line_webhook_events e
       JOIN users u ON u.line_user_id = e.payload #>> '{source,userId}'
      WHERE e.event_id = $1`,
    [eventId],
  )
  console.log(JSON.stringify({ event: result.rows, actor: actor.rows, pointRules: rules.rows }, null, 2))
} finally {
  await client.end()
}
