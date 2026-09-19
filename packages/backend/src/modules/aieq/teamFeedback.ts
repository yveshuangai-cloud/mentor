import { platformQuery } from '../../db/index.js'
import type { AieqIdentity } from './auth.js'

// 「團隊回報小標籤」: test-period feedback from team members, one row per press.
// Gated by config.aieqTeamFeedback at the route; this module never checks the flag itself.

export const TEAM_FEEDBACK_VERDICTS = ['good', 'issue', 'other'] as const
export type TeamFeedbackVerdict = (typeof TEAM_FEEDBACK_VERDICTS)[number]

// intro | question:q03_ai_image | result:story | result:radar | result:cover | result:share | friends
export const TEAM_FEEDBACK_SPOT = /^[a-z]{2,20}(?::[a-z0-9_]{1,40})?$/

export const VERDICT_LABELS: Record<TeamFeedbackVerdict, string> = {
  good: '這裡規劃得很好',
  issue: '這裡規劃有問題',
  other: '我有其他意見',
}

export interface TeamFeedbackInput {
  spot: string
  verdict: TeamFeedbackVerdict
  comment?: string
  typeCode?: string
  sessionId?: string
  userAgent?: string
}

export interface TeamFeedbackEntry {
  id: number
  spot: string
  verdict: TeamFeedbackVerdict
  comment: string | null
  lineUserId: string
  displayName: string | null
  pictureUrl: string | null
  typeCode: string | null
  instrumentVersion: string | null
  createdAt: string
}

export interface TeamFeedbackSummary {
  total: number
  reporters: number
  bySpot: Array<{ spot: string; good: number; issue: number; other: number; lastAt: string }>
  entries: TeamFeedbackEntry[]
}

export async function recordTeamFeedback(who: AieqIdentity, input: TeamFeedbackInput): Promise<{ id: number; createdAt: string }> {
  // The instrument version comes from the player's own session so a report can be tied to the question bank they saw.
  let instrumentVersion: string | null = null
  if (input.sessionId) {
    const session = await platformQuery<{ instrument_version: string }>(
      `SELECT instrument_version FROM aieq_sessions WHERE id=$1 AND user_id=$2`, [input.sessionId, who.userId],
    )
    instrumentVersion = session.rows[0]?.instrument_version ?? null
  }
  const comment = input.comment?.trim() || null
  const row = await platformQuery<{ id: string; created_at: Date }>(
    `INSERT INTO aieq_team_feedback
       (user_id, line_user_id, display_name, picture_url, spot, verdict, comment, type_code, session_id, instrument_version, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     RETURNING id, created_at`,
    [
      who.userId, who.lineUserId, who.displayName ?? null, who.pictureUrl ?? null,
      input.spot, input.verdict, comment, input.typeCode ?? null,
      instrumentVersion ? input.sessionId ?? null : null, instrumentVersion, input.userAgent?.slice(0, 300) ?? null,
    ],
  )
  return { id: Number(row.rows[0].id), createdAt: row.rows[0].created_at.toISOString() }
}

// Latest verdict per spot for one reporter, so the tag can show what they already said after a reload.
export async function listMyTeamFeedback(userId: number): Promise<Record<string, { verdict: TeamFeedbackVerdict; comment: string | null }>> {
  const rows = await platformQuery<{ spot: string; verdict: TeamFeedbackVerdict; comment: string | null }>(
    `SELECT DISTINCT ON (spot) spot, verdict, comment FROM aieq_team_feedback WHERE user_id=$1 ORDER BY spot, created_at DESC`, [userId],
  )
  return Object.fromEntries(rows.rows.map((row) => [row.spot, { verdict: row.verdict, comment: row.comment }]))
}

export async function summarizeTeamFeedback(limit = 200): Promise<TeamFeedbackSummary> {
  const totals = await platformQuery<{ total: string; reporters: string }>(
    `SELECT count(*) AS total, count(DISTINCT line_user_id) AS reporters FROM aieq_team_feedback`,
  )
  const bySpot = await platformQuery<{ spot: string; good: string; issue: string; other: string; last_at: Date }>(
    `SELECT spot,
            count(*) FILTER (WHERE verdict='good') AS good,
            count(*) FILTER (WHERE verdict='issue') AS issue,
            count(*) FILTER (WHERE verdict='other') AS other,
            max(created_at) AS last_at
     FROM aieq_team_feedback GROUP BY spot ORDER BY issue DESC, other DESC, spot`,
  )
  const entries = await platformQuery<{
    id: string; spot: string; verdict: TeamFeedbackVerdict; comment: string | null; line_user_id: string
    display_name: string | null; picture_url: string | null; type_code: string | null; instrument_version: string | null; created_at: Date
  }>(
    `SELECT id, spot, verdict, comment, line_user_id, display_name, picture_url, type_code, instrument_version, created_at
     FROM aieq_team_feedback ORDER BY created_at DESC LIMIT $1`, [limit],
  )
  return {
    total: Number(totals.rows[0]?.total ?? 0),
    reporters: Number(totals.rows[0]?.reporters ?? 0),
    bySpot: bySpot.rows.map((row) => ({
      spot: row.spot, good: Number(row.good), issue: Number(row.issue), other: Number(row.other), lastAt: row.last_at.toISOString(),
    })),
    entries: entries.rows.map((row) => ({
      id: Number(row.id), spot: row.spot, verdict: row.verdict, comment: row.comment, lineUserId: row.line_user_id,
      displayName: row.display_name, pictureUrl: row.picture_url, typeCode: row.type_code,
      instrumentVersion: row.instrument_version, createdAt: row.created_at.toISOString(),
    })),
  }
}

// Human-readable screen names for reports; mirrors teamFeedbackSpotLabel in public/aieq-core.js.
export function teamFeedbackSpotLabel(spot: string): string {
  const fixed: Record<string, string> = {
    intro: '封面／開始頁', 'result:story': '結果解讀', 'result:radar': '雷達圖', 'result:cover': '人格封面',
    'result:share': '封面與分享', friends: '分享給好友頁',
  }
  if (fixed[spot]) return fixed[spot]
  const question = /^question:q(\d+)_/.exec(spot)
  if (question) return `第 ${Number(question[1])} 題`
  return spot
}
