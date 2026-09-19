import { describe, expect, it } from 'vitest'
import {
  AIEQ_QUESTIONS,
  INSTRUMENT_VERSION,
  QUESTION_BANKS,
  createAieqSession,
  questionsFor,
  scoreAssessment,
  transitionAieqSession,
  type AieqSession,
} from '../src/modules/aieq/index.js'

const NOW = '2026-09-18T10:00:00.000Z'

function play(version: string, picks: number[]): AieqSession {
  let session: AieqSession = { ...createAieqSession(`s-${version}`, NOW), instrumentVersion: version }
  const bank = questionsFor(version)
  picks.forEach((pick, index) => {
    const result = transitionAieqSession(session, {
      eventId: `e-${index}`, sessionId: session.id, source: 'card', kind: 'answer',
      questionId: bank[index].id, optionId: bank[index].options[pick].id,
      occurredAt: NOW, interpretationConfidence: 1,
    }, bank)
    expect(result.accepted).toBe(true)
    session = result.session
  })
  return session
}

describe('AI Personality instrument versions', () => {
  it('stamps new sessions with the current version and keeps every historical bank', () => {
    expect(createAieqSession('x', NOW).instrumentVersion).toBe(INSTRUMENT_VERSION)
    expect(Object.keys(QUESTION_BANKS)).toEqual([
      'ai-personality-1.0-7q', 'ai-personality-1.1-8q', 'ai-personality-2.0-8q',
    ])
    expect(questionsFor(INSTRUMENT_VERSION)).toBe(AIEQ_QUESTIONS)
  })

  it('scores a 2026-09-11 session with the seven-question bank it was answered under', () => {
    const legacy = play('ai-personality-1.0-7q', [0, 0, 1, 1, 2, 0, 2])
    expect(legacy.status).toBe('completed')
    const result = scoreAssessment(legacy, questionsFor(legacy.instrumentVersion))
    expect(result.axes.action.evidenceCount).toBe(1)
    expect(result.instrumentVersion).toBe('ai-personality-1.0-7q')
    // The same seven answers do not complete a current session: an eighth item is still pending.
    const current = play(INSTRUMENT_VERSION, [0, 0, 1, 1, 2, 0, 2])
    expect(current.status).toBe('in_progress')
    expect(current.currentQuestionIndex).toBe(7)
  })

  it('freezes the two everyday banks against each other, apart from the current one', () => {
    const seven = questionsFor('ai-personality-1.0-7q')
    const eight = questionsFor('ai-personality-1.1-8q')
    expect(seven).toHaveLength(7)
    expect(eight).toHaveLength(8)
    seven.forEach((question, index) => {
      expect(question.id).toBe(eight[index].id)
      expect(question.options.map((o) => [o.id, o.evidence])).toEqual(eight[index].options.map((o) => [o.id, o.evidence]))
    })
    // The workplace bank replaced them, so it shares no question id with either.
    const older = new Set(eight.map((q) => q.id))
    for (const question of AIEQ_QUESTIONS) expect(older.has(question.id), question.id).toBe(false)
  })

  it('refuses to score an unknown version rather than guessing a bank', () => {
    expect(() => questionsFor('ai-personality-9.9-0q')).toThrow(/unknown_instrument_version/)
  })
})
