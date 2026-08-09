import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { createServer } from 'node:net'
import EmbeddedPostgres from 'embedded-postgres'

async function availablePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') return reject(new Error('no_test_port'))
      server.close(() => resolve(address.port))
    })
  })
}

const port = await availablePort()
const postgres = new EmbeddedPostgres({
  databaseDir: join('C:\\tmp', `aieq-pg-${randomUUID()}`),
  port,
  user: 'postgres',
  password: 'aieq-test-password',
  persistent: false,
  initdbFlags: ['--locale=C', '--encoding=UTF8'],
  onLog: () => {},
  onError: (error) => console.error(error),
})

try {
  await postgres.initialise()
  await postgres.start()
  process.env.DATABASE_URL = `postgresql://postgres:aieq-test-password@127.0.0.1:${port}/postgres`
  process.env.NODE_ENV = 'test'

  const { autoMigrate, platformQuery, pool } = await import('../src/db/index.js')
  const { AIEQ_QUESTIONS } = await import('../src/modules/aieq/questions.js')
  const {
    appendEvent,
    claimFriendInvite,
    confirmProfile,
    createFriendInvite,
    deleteAieqData,
    findOrCreateSession,
    getProfile,
    listFriends,
  } = await import('../src/modules/aieq/repository.js')

  await autoMigrate(() => {})
  const user = await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id,display_name) VALUES ('U-AIEQ-1','測試河狸') RETURNING id`,
  )
  const friend = await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id,display_name) VALUES ('U-AIEQ-2','測試朋友') RETURNING id`,
  )
  let session = await findOrCreateSession(user.rows[0].id)
  const concurrent = await findOrCreateSession(user.rows[0].id)
  assert.equal(concurrent.id, session.id, 'only one open session may exist per user')

  for (const [index, question] of AIEQ_QUESTIONS.entries()) {
    const event = {
      eventId: `integration-${index}`,
      sessionId: session.id,
      source: 'card' as const,
      kind: 'answer' as const,
      questionId: question.id,
      optionId: index % 2 === 0 ? 'a' : 'b',
      occurredAt: new Date(Date.now() + index).toISOString(),
      interpretationConfidence: 1,
    }
    const applied = await appendEvent(user.rows[0].id, event)
    assert.equal(applied.accepted, true)
    if (index === 0) assert.equal((await appendEvent(user.rows[0].id, event)).duplicate, true)
    session = applied.session
  }
  assert.equal(session.status, 'completed')

  await confirmProfile(user.rows[0].id, session.id, {
    visibleToFriends: true,
    personalizationConsent: false,
  })
  assert.ok(await getProfile(user.rows[0].id), 'confirmed profile must be readable')
  const invite = await createFriendInvite(user.rows[0].id)
  await claimFriendInvite(friend.rows[0].id, invite.token)
  const friends = await listFriends(friend.rows[0].id)
  assert.equal(friends.length, 1)
  assert.equal(friends[0].display_name, '測試河狸')
  await deleteAieqData(user.rows[0].id)
  assert.equal(await getProfile(user.rows[0].id), null)
  assert.equal((await listFriends(friend.rows[0].id)).length, 0)

  await pool.end()
  console.log('AIEQ integration: migration, idempotency, scoring, confirmation and friendship passed')
} finally {
  await postgres.stop().catch(() => {})
}
