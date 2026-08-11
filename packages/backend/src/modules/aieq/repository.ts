import { randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { platformQuery, withTransaction } from '../../db/index.js'
import { AIEQ_QUESTIONS } from './questions.js'
import { animalForCode } from './catalog.js'
import { scoreAssessment } from './scoring.js'
import { createAieqSession, transitionAieqSession } from './stateMachine.js'
import type { AieqSession, AnswerEvent, RecordedAnswer } from './types.js'

interface SessionRow {
  id: string
  instrument_version: string
  status: AieqSession['status']
  current_question_index: number
  personalization_consent: boolean
  started_at: Date
  updated_at: Date
  completed_at: Date | null
  result: unknown
}

interface EventRow {
  event_id: string
  source: AnswerEvent['source']
  kind: AnswerEvent['kind']
  occurred_at: Date
  question_id: string | null
  option_id: string | null
  raw_text: string | null
  interpretation_confidence: string | number | null
}

interface AnswerRow {
  question_id: string
  source_event_id: string
  source: RecordedAnswer['source']
  option_id: string | null
  raw_text: string | null
  interpretation_confidence: string | number
}

async function loadWith(client: pg.PoolClient, id: string, userId: number, lock = false): Promise<AieqSession | null> {
  const sessionResult = await client.query<SessionRow>(
    `SELECT * FROM aieq_sessions WHERE id = $1 AND user_id = $2${lock ? ' FOR UPDATE' : ''}`,
    [id, userId],
  )
  const row = sessionResult.rows[0]
  if (!row) return null
  const [events, answers] = await Promise.all([
    client.query<EventRow>(`SELECT * FROM aieq_answer_events WHERE session_id = $1 ORDER BY received_at, event_id`, [id]),
    client.query<AnswerRow>(
      `SELECT a.*, e.source, e.raw_text FROM aieq_answers a
       JOIN aieq_answer_events e ON e.event_id = a.source_event_id WHERE a.session_id = $1`,
      [id],
    ),
  ])
  return {
    id: row.id,
    instrumentVersion: row.instrument_version,
    status: row.status,
    currentQuestionIndex: row.current_question_index,
    personalizationConsent: row.personalization_consent,
    startedAt: row.started_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    completedAt: row.completed_at?.toISOString(),
    processedEventIds: events.rows.map((event) => event.event_id),
    eventLog: events.rows.map((event) => ({
      eventId: event.event_id,
      sessionId: id,
      source: event.source,
      kind: event.kind,
      occurredAt: event.occurred_at.toISOString(),
      questionId: event.question_id ?? undefined,
      optionId: event.option_id ?? undefined,
      rawText: event.raw_text ?? undefined,
      interpretationConfidence: event.interpretation_confidence == null ? undefined : Number(event.interpretation_confidence),
    })),
    answers: Object.fromEntries(answers.rows.map((answer) => [answer.question_id, {
      questionId: answer.question_id,
      optionId: answer.option_id ?? undefined,
      source: answer.source,
      eventId: answer.source_event_id,
      interpretationConfidence: Number(answer.interpretation_confidence),
      rawText: answer.raw_text ?? undefined,
    }])),
  }
}

export async function findOrCreateSession(userId: number, tenantId?: number): Promise<AieqSession> {
  return withTransaction(async (client) => {
    const canonical = await client.query<{ session_id: string }>(
      `SELECT session_id FROM aieq_profiles WHERE user_id=$1`, [userId],
    )
    if (canonical.rows[0]) return (await loadWith(client, canonical.rows[0].session_id, userId))!

    const existing = await client.query<{ id: string }>(
      `SELECT id FROM aieq_sessions WHERE user_id = $1 AND status IN ('in_progress','paused')
       ORDER BY updated_at DESC LIMIT 1 FOR UPDATE`,
      [userId],
    )
    if (existing.rows[0]) return (await loadWith(client, existing.rows[0].id, userId))!
    const session = createAieqSession(randomUUID())
    const inserted = await client.query(
      `INSERT INTO aieq_sessions
       (id, tenant_id, user_id, instrument_version, status, current_question_index, started_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT DO NOTHING`,
      [session.id, tenantId ?? null, userId, session.instrumentVersion, session.status, 0, session.startedAt],
    )
    if (inserted.rowCount === 0) {
      const winner = await client.query<{ id: string }>(
        `SELECT id FROM aieq_sessions WHERE user_id=$1 AND status IN ('in_progress','paused')
         ORDER BY updated_at DESC LIMIT 1`, [userId],
      )
      if (!winner.rows[0]) throw new Error('session_create_conflict')
      return (await loadWith(client, winner.rows[0].id, userId))!
    }
    return session
  })
}

export async function getSession(userId: number, sessionId: string): Promise<AieqSession | null> {
  return withTransaction((client) => loadWith(client, sessionId, userId))
}

export async function getConfirmedProfileSession(userId: number): Promise<AieqSession | null> {
  const result = await platformQuery<{ session_id: string }>(
    `SELECT session_id FROM aieq_profiles WHERE user_id=$1`, [userId],
  )
  return result.rows[0] ? getSession(userId, result.rows[0].session_id) : null
}

export async function findActiveSession(userId: number): Promise<AieqSession | null> {
  return withTransaction(async (client) => {
    const result = await client.query<{ id: string }>(
      `SELECT id FROM aieq_sessions WHERE user_id=$1 AND status IN ('in_progress','paused')
       ORDER BY updated_at DESC LIMIT 1`, [userId],
    )
    return result.rows[0] ? loadWith(client, result.rows[0].id, userId) : null
  })
}

export async function appendEvent(userId: number, event: AnswerEvent): Promise<{
  session: AieqSession
  duplicate: boolean
  accepted: boolean
  reason?: string
}> {
  return withTransaction(async (client) => {
    const current = await loadWith(client, event.sessionId, userId, true)
    if (!current) throw new Error('session_not_found')
    const transition = transitionAieqSession(current, event, AIEQ_QUESTIONS)
    if (transition.duplicate || !transition.accepted) return transition

    const inserted = await client.query(
      `INSERT INTO aieq_answer_events
       (event_id, session_id, source, kind, question_id, option_id, raw_text, interpretation_confidence, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (event_id) DO NOTHING`,
      [event.eventId, event.sessionId, event.source, event.kind, event.questionId ?? null,
       event.optionId ?? null, event.rawText ?? null, event.interpretationConfidence ?? null, event.occurredAt],
    )
    if (inserted.rowCount === 0) return { session: current, duplicate: true, accepted: true }

    await client.query(`DELETE FROM aieq_answers WHERE session_id = $1`, [event.sessionId])
    for (const answer of Object.values(transition.session.answers)) {
      await client.query(
        `INSERT INTO aieq_answers
         (session_id, question_id, source_event_id, option_id, interpretation_confidence)
         VALUES ($1,$2,$3,$4,$5)`,
        [event.sessionId, answer.questionId, answer.eventId, answer.optionId ?? null, answer.interpretationConfidence],
      )
    }
    const result = transition.session.status === 'completed' ? scoreAssessment(transition.session) : null
    await client.query(
      `UPDATE aieq_sessions SET status=$2, current_question_index=$3, result=$4,
       updated_at=$5, completed_at=$6 WHERE id=$1`,
      [event.sessionId, transition.session.status, transition.session.currentQuestionIndex,
       result ? JSON.stringify(result) : null, transition.session.updatedAt, transition.session.completedAt ?? null],
    )
    return transition
  })
}

export async function confirmProfile(userId: number, sessionId: string, options: {
  visibleToFriends: boolean
  personalizationConsent: boolean
}): Promise<void> {
  await withTransaction(async (client) => {
    const session = await loadWith(client, sessionId, userId, true)
    if (!session || session.status !== 'completed') throw new Error('completed_session_required')
    const result = scoreAssessment(session)
    if (result.preferenceCode.includes('X')) throw new Error('insufficient_preference_evidence')
    const animal = animalForCode(result.preferenceCode)
    const pendingInvite = await client.query(
      `SELECT 1 FROM aieq_friend_invites
       WHERE claimed_by_user_id=$1 AND status='claimed' AND expires_at>now() LIMIT 1`, [userId],
    )
    const visibility = options.visibleToFriends || pendingInvite.rowCount ? 'friends' : 'private'
    await client.query(
      `INSERT INTO aieq_profiles (user_id,session_id,type_code,animal_slug,visibility)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET session_id=EXCLUDED.session_id,type_code=EXCLUDED.type_code,
       animal_slug=EXCLUDED.animal_slug,visibility=EXCLUDED.visibility,confirmed_at=now(),updated_at=now()`,
      [userId, sessionId, result.preferenceCode, animal.slug, visibility],
    )
    await client.query(
      `UPDATE aieq_sessions SET personalization_consent=$2,
       consent_granted_at=CASE WHEN $2 THEN COALESCE(consent_granted_at,now()) ELSE NULL END WHERE id=$1`,
      [sessionId, options.personalizationConsent],
    )
    await finalizeClaimedInvites(client, userId)
  })
}

export async function getProfile(userId: number): Promise<Record<string, unknown> | null> {
  const result = await platformQuery<{
    session_id: string; type_code: string; animal_slug: string; visibility: string; confirmed_at: Date; result: unknown
  }>(
    `SELECT p.session_id,p.type_code,p.animal_slug,p.visibility,p.confirmed_at,s.result
     FROM aieq_profiles p JOIN aieq_sessions s ON s.id=p.session_id WHERE p.user_id=$1`, [userId],
  )
  const row = result.rows[0]
  return row ? { ...row, animal: animalForCode(row.type_code) } : null
}

export async function createFriendInvite(userId: number): Promise<{ token: string; expiresAt: string }> {
  return withTransaction(async (client) => {
    const profile = await client.query(`SELECT 1 FROM aieq_profiles WHERE user_id=$1 FOR UPDATE`, [userId])
    if (!profile.rowCount) throw new Error('confirmed_profile_required')
    const token = randomBytes(18).toString('base64url')
    const result = await client.query<{ expires_at: Date }>(
      `INSERT INTO aieq_friend_invites (token,inviter_user_id,expires_at)
       VALUES ($1,$2,now()+interval '7 days') RETURNING expires_at`, [token, userId],
    )
    // Pressing “invite” is the explicit moment the user chooses social visibility.
    await client.query(`UPDATE aieq_profiles SET visibility='friends',updated_at=now() WHERE user_id=$1`, [userId])
    return { token, expiresAt: result.rows[0].expires_at.toISOString() }
  })
}

async function finalizeClaimedInvites(client: pg.PoolClient, recipientUserId: number): Promise<number> {
  const invites = await client.query<{ token: string; inviter_user_id: number }>(
    `SELECT i.token,i.inviter_user_id FROM aieq_friend_invites i
     JOIN aieq_profiles inviter_profile ON inviter_profile.user_id=i.inviter_user_id
     WHERE i.claimed_by_user_id=$1 AND i.status='claimed' AND i.expires_at>now()
     FOR UPDATE OF i`, [recipientUserId],
  )
  for (const invite of invites.rows) {
    const low = Math.min(recipientUserId, invite.inviter_user_id)
    const high = Math.max(recipientUserId, invite.inviter_user_id)
    await client.query(
      `INSERT INTO aieq_friendships (user_low_id,user_high_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [low, high],
    )
    await client.query(`UPDATE aieq_friend_invites SET status='accepted' WHERE token=$1`, [invite.token])
  }
  return invites.rowCount ?? 0
}

export async function claimFriendInvite(userId: number, token: string): Promise<'pending' | 'connected'> {
  return withTransaction(async (client) => {
    const result = await client.query<{
      inviter_user_id: number
      claimed_by_user_id: number | null
      status: 'issued' | 'claimed' | 'accepted' | 'expired'
    }>(
      `SELECT inviter_user_id,claimed_by_user_id,status FROM aieq_friend_invites
       WHERE token=$1 AND expires_at>now() FOR UPDATE`, [token],
    )
    const invite = result.rows[0]
    if (!invite) throw new Error('invite_invalid_or_expired')
    if (invite.inviter_user_id === userId) throw new Error('cannot_friend_self')
    if (invite.claimed_by_user_id && invite.claimed_by_user_id !== userId) throw new Error('invite_already_claimed')
    if (invite.status === 'accepted') return 'connected'
    await client.query(
      `UPDATE aieq_friend_invites SET claimed_by_user_id=$2,
       claimed_at=COALESCE(claimed_at,now()),status='claimed' WHERE token=$1`,
      [token, userId],
    )
    const hasConfirmedProfile = await client.query(`SELECT 1 FROM aieq_profiles WHERE user_id=$1`, [userId])
    if (hasConfirmedProfile.rowCount) {
      await finalizeClaimedInvites(client, userId)
      return 'connected'
    }
    return 'pending'
  })
}

export async function listFriends(userId: number): Promise<Array<Record<string, unknown>>> {
  const result = await platformQuery<{
    id: number; display_name: string | null; picture_url: string | null; type_code: string; animal_slug: string
  }>(
    `SELECT u.id,u.display_name,u.picture_url,p.type_code,p.animal_slug
     FROM aieq_friendships f
     JOIN users u ON u.id=CASE WHEN f.user_low_id=$1 THEN f.user_high_id ELSE f.user_low_id END
     JOIN aieq_profiles p ON p.user_id=u.id AND p.visibility='friends'
     WHERE f.user_low_id=$1 OR f.user_high_id=$1 ORDER BY u.display_name NULLS LAST`, [userId],
  )
  return result.rows.map((row) => ({ ...row, animal: animalForCode(row.type_code) }))
}

export async function deleteAieqData(userId: number): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(`DELETE FROM aieq_profiles WHERE user_id=$1`, [userId])
    await client.query(`DELETE FROM aieq_friend_invites WHERE inviter_user_id=$1 OR claimed_by_user_id=$1`, [userId])
    await client.query(`DELETE FROM aieq_friendships WHERE user_low_id=$1 OR user_high_id=$1`, [userId])
    await client.query(
      `DELETE FROM aieq_answers WHERE session_id IN (SELECT id FROM aieq_sessions WHERE user_id=$1)`, [userId],
    )
    await client.query(
      `DELETE FROM aieq_answer_events WHERE session_id IN (SELECT id FROM aieq_sessions WHERE user_id=$1)`, [userId],
    )
    await client.query(`DELETE FROM aieq_sessions WHERE user_id=$1`, [userId])
  })
}
