import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
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
  databaseDir: join(tmpdir(), `aieq-pg-${randomUUID()}`),
  port,
  user: 'postgres',
  password: 'aieq-test-password',
  persistent: false,
  initdbFlags: ['--locale=C', '--encoding=UTF8'],
  onLog: () => {},
  onError: (error) => console.error(error),
})

let closePool: (() => Promise<void>) | undefined

try {
  await postgres.initialise()
  await postgres.start()
  process.env.DATABASE_URL = `postgresql://postgres:aieq-test-password@127.0.0.1:${port}/postgres`
  process.env.NODE_ENV = 'test'

  const { autoMigrate, platformQuery, pool } = await import('../src/db/index.js')
  closePool = () => pool.end()
  const { AIEQ_QUESTIONS, questionsFor } = await import('../src/modules/aieq/questions.js')
  // The 1.0 session below was answered under the everyday bank, which is not the live one any more.
  const LEGACY_BANK = questionsFor('ai-personality-1.0-7q')
  const { listMyTeamFeedback, recordTeamFeedback, summarizeTeamFeedback } = await import('../src/modules/aieq/teamFeedback.js')
  const {
    appendEvent,
    claimFriendInvite,
    confirmProfile,
    createFriendInvite,
    deleteAieqData,
    findCurrentSession,
    findOrCreateSession,
    getProfile,
    listFriends,
    listFriendsOfFriends,
    setProfileVisibility,
    getFunnelStats,
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
      optionId: question.options[index % 2 === 0 ? 0 : 1].id,
      occurredAt: new Date(Date.now() + index).toISOString(),
      interpretationConfidence: 1,
    }
    const applied = await appendEvent(user.rows[0].id, event)
    assert.equal(applied.accepted, true)
    if (index === 0) assert.equal((await appendEvent(user.rows[0].id, event)).duplicate, true)
    session = applied.session
  }
  assert.equal(session.status, 'completed')
  assert.equal(
    (await findCurrentSession(user.rows[0].id))?.id,
    session.id,
    'a completed but unconfirmed result must still be shown when the user comes back',
  )
  assert.equal(
    (await findOrCreateSession(user.rows[0].id)).id,
    session.id,
    'a completed but unconfirmed session must not be replaced by a new session',
  )

  await confirmProfile(user.rows[0].id, session.id, {
    visibleToFriends: true,
    personalizationConsent: false,
  })
  assert.ok(await getProfile(user.rows[0].id), 'confirmed profile must be readable')
  assert.equal(
    (await findOrCreateSession(user.rows[0].id)).id,
    session.id,
    'confirmed users must return the canonical result instead of starting another session',
  )
  const invite = await createFriendInvite(user.rows[0].id)
  assert.equal((await createFriendInvite(user.rows[0].id)).token, invite.token, 'sharing twice reuses the live invite link')
  assert.equal((await getProfile(user.rows[0].id))?.visibility, 'friends')
  assert.equal(await claimFriendInvite(friend.rows[0].id, invite.token), 'pending')
  assert.equal((await listFriends(friend.rows[0].id)).length, 0, 'claiming alone must not create friendship')

  let friendSession = await findOrCreateSession(friend.rows[0].id)
  for (const [index, question] of AIEQ_QUESTIONS.entries()) {
    friendSession = (await appendEvent(friend.rows[0].id, {
      eventId: `friend-integration-${index}`,
      sessionId: friendSession.id,
      source: 'card',
      kind: 'answer',
      questionId: question.id,
      optionId: question.options[index % 2 === 0 ? 1 : 2].id,
      occurredAt: new Date(Date.now() + 100 + index).toISOString(),
      interpretationConfidence: 1,
    })).session
  }
  await confirmProfile(friend.rows[0].id, friendSession.id, {
    visibleToFriends: true,
    personalizationConsent: false,
  })
  const friends = await listFriends(friend.rows[0].id)
  assert.equal(friends.length, 1)
  assert.equal(friends[0].display_name, '測試河狸')

  // Friends of friends: a third player becomes the friend's friend, never the user's.
  const third = await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id,display_name) VALUES ('U-AIEQ-3','測試第三人') RETURNING id`,
  )
  const thirdInvite = await createFriendInvite(friend.rows[0].id)
  assert.equal(await claimFriendInvite(third.rows[0].id, thirdInvite.token), 'pending')
  let thirdSession = await findOrCreateSession(third.rows[0].id)
  for (const [index, question] of AIEQ_QUESTIONS.entries()) {
    thirdSession = (await appendEvent(third.rows[0].id, {
      eventId: `third-integration-${index}`,
      sessionId: thirdSession.id,
      source: 'card',
      kind: 'answer',
      questionId: question.id,
      optionId: question.options[index % 3].id,
      occurredAt: new Date(Date.now() + 200 + index).toISOString(),
      interpretationConfidence: 1,
    })).session
  }
  await confirmProfile(third.rows[0].id, thirdSession.id, { visibleToFriends: true, personalizationConsent: false })
  assert.equal((await listFriends(friend.rows[0].id)).length, 2, 'the friend now has two direct friends')
  assert.equal((await listFriends(user.rows[0].id)).length, 1, 'the user still has one direct friend')

  assert.equal(await listFriendsOfFriends(user.rows[0].id), null, 'second-degree list is withheld until the viewer opts in')
  await setProfileVisibility(user.rows[0].id, 'friends_of_friends')
  assert.deepEqual(await listFriendsOfFriends(user.rows[0].id), [], 'the third player has not opted in, so they stay invisible')
  await setProfileVisibility(third.rows[0].id, 'friends_of_friends')
  const second = await listFriendsOfFriends(user.rows[0].id)
  assert.equal(second?.length, 1)
  assert.equal(second?.[0].display_name, '測試第三人')
  assert.deepEqual(second?.[0].via_names, ['測試朋友'], 'shows who the connection runs through')
  assert.equal(second?.[0].mutual_count, 1)
  // A session stamped with the retired seven-question bank still completes after seven answers and is scored by that bank.
  const legacyUser = await platformQuery<{ id: number }>(
    `INSERT INTO users (line_user_id,display_name) VALUES ('U-AIEQ-LEGACY','舊版玩家') RETURNING id`,
  )
  const legacyId = randomUUID()
  await platformQuery(
    `INSERT INTO aieq_sessions (id,user_id,instrument_version,status,current_question_index,started_at,updated_at)
     VALUES ($1,$2,'ai-personality-1.0-7q','in_progress',0,now(),now())`, [legacyId, legacyUser.rows[0].id],
  )
  let legacy = (await findOrCreateSession(legacyUser.rows[0].id))
  assert.equal(legacy.id, legacyId)
  for (let index = 0; index < 7; index++) {
    legacy = (await appendEvent(legacyUser.rows[0].id, {
      eventId: `legacy-${index}`, sessionId: legacyId, source: 'card', kind: 'answer',
      questionId: LEGACY_BANK[index].id, optionId: LEGACY_BANK[index].options[0].id,
      occurredAt: new Date(Date.now() + 300 + index).toISOString(), interpretationConfidence: 1,
    })).session
  }
  assert.equal(legacy.status, 'completed', 'seven answers complete a 1.0-7q session')
  await confirmProfile(legacyUser.rows[0].id, legacyId, { visibleToFriends: false, personalizationConsent: false })
  assert.match(String((await getProfile(legacyUser.rows[0].id))?.type_code), /^(out|in)-(real|idea)-(logic|feel)-(plan|flex)$/)
  await deleteAieqData(legacyUser.rows[0].id)

  // 團隊回報小標籤: the reporter's LINE identity is kept, replay/delete of quiz data leaves the notes alone.
  const reporter = { userId: user.rows[0].id, lineUserId: 'U-AIEQ-1', displayName: '測試河狸', pictureUrl: 'https://profile.line-scdn.net/beaver' }
  await recordTeamFeedback(reporter, { spot: 'intro', verdict: 'good', sessionId: session.id, userAgent: 'integration' })
  await recordTeamFeedback(reporter, { spot: 'question:q03_ai_image', verdict: 'issue', comment: '第三題 B 太長', typeCode: 'ENTP', sessionId: 'not-mine' })
  await recordTeamFeedback(reporter, { spot: 'question:q03_ai_image', verdict: 'other', comment: '改口：其實還好' })
  const mine = await listMyTeamFeedback(user.rows[0].id)
  assert.equal(mine['question:q03_ai_image']?.verdict, 'other', 'the latest verdict per screen wins')
  assert.equal(mine.intro?.verdict, 'good')
  const feedback = await summarizeTeamFeedback()
  assert.equal(feedback.total, 3)
  assert.equal(feedback.reporters, 1)
  assert.deepEqual(feedback.bySpot.map((s) => [s.spot, s.good, s.issue, s.other]), [['question:q03_ai_image', 0, 1, 1], ['intro', 1, 0, 0]])
  assert.equal(feedback.entries[2].instrumentVersion, session.instrumentVersion, 'a report is tied to the question bank the reporter saw')
  assert.equal(feedback.entries[1].instrumentVersion, null, 'a session id that is not the reporter\'s is ignored')
  assert.equal(feedback.entries[0].displayName, '測試河狸')
  assert.equal(feedback.entries[0].pictureUrl, 'https://profile.line-scdn.net/beaver')

  const stats = await getFunnelStats()
  assert.equal(stats.startedUsers, 3)
  assert.equal(stats.completedSessions, 3)
  assert.equal(stats.confirmed, 3)
  assert.equal(stats.invitesAccepted, 2)
  assert.equal(stats.friendships, 2)
  assert.equal(stats.types.reduce((n, t) => n + t.count, 0), 3)
  assert.ok(stats.days.length >= 1 && stats.days[0].started === 3)
  assert.equal('strength' in (second?.[0] ?? {}), false, 'only nickname, avatar and type leave the server')
  assert.equal((await listFriends(user.rows[0].id)).length, 1, 'opting in does not hide direct friends')
  await confirmProfile(user.rows[0].id, session.id, { visibleToFriends: false, personalizationConsent: false })
  assert.equal((await getProfile(user.rows[0].id))?.visibility, 'friends_of_friends', 're-confirming a result never downgrades an opted-in player')
  await deleteAieqData(friend.rows[0].id)
  assert.deepEqual(await listFriendsOfFriends(user.rows[0].id), [], 'losing the connecting friend removes their friends too')
  await deleteAieqData(third.rows[0].id)

  await deleteAieqData(user.rows[0].id)
  assert.equal(await getProfile(user.rows[0].id), null)
  assert.equal((await summarizeTeamFeedback()).total, 3, 'deleting quiz data never deletes team feedback')
  assert.equal((await listFriends(friend.rows[0].id)).length, 0)

  console.log('AIEQ integration: migration, idempotency, scoring, confirmation, friendship and friends-of-friends passed')
} finally {
  // Close pooled connections first; otherwise stopping Postgres masks the real failure.
  await closePool?.().catch(() => {})
  await postgres.stop().catch(() => {})
}
