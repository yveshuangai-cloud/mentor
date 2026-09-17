import { describe, expect, it } from 'vitest'
import {
  AIEQ_QUESTIONS,
  createAieqSession,
  scoreAssessment,
  transitionAieqSession,
  type AieqSession,
} from '../src/modules/aieq/index.js'

// These tests run the real scoring engine over every possible way to answer the quiz.
// They do not prove the questions measure personality; they prove the weights do not quietly
// push everyone toward one letter or one animal. Re-run them whenever a weight or question changes.

const AXES = ['EI', 'SN', 'TF', 'JP'] as const
type Axis = (typeof AXES)[number]

function score(picks: number[]) {
  let session: AieqSession = createAieqSession('balance')
  picks.forEach((pick, index) => {
    const question = AIEQ_QUESTIONS[index]
    session = transitionAieqSession(session, {
      eventId: `balance-${index}`,
      sessionId: session.id,
      source: 'card',
      kind: 'answer',
      questionId: question.id,
      optionId: question.options[pick].id,
      occurredAt: new Date(1_000_000_000_000 + index).toISOString(),
      interpretationConfidence: 1,
    }, AIEQ_QUESTIONS).session
  })
  return scoreAssessment(session)
}

function everyAnswerSheet(): number[][] {
  const sheets: number[][] = []
  const total = 3 ** AIEQ_QUESTIONS.length
  for (let code = 0; code < total; code++) {
    const picks: number[] = []
    let rest = code
    for (let i = 0; i < AIEQ_QUESTIONS.length; i++) { picks.push(rest % 3); rest = Math.floor(rest / 3) }
    sheets.push(picks)
  }
  return sheets
}

const weights = (axis: Axis) => AIEQ_QUESTIONS
  .filter((question) => question.dimensions.includes(axis))
  .map((question) => question.options.map((option) => option.evidence[axis] ?? 0))

describe('AI Personality answer-space balance', () => {
  const results = everyAnswerSheet().map(score)

  it('gives every axis two questions so no letter hangs on a single tap', () => {
    for (const axis of AXES) expect(weights(axis), axis).toHaveLength(2)
  })

  it('never lets an axis land exactly on zero, because ties are silently read as the right-hand letter', () => {
    for (const axis of AXES) {
      const [first, second] = weights(axis)
      for (const a of first) for (const b of second) expect(a + b, `${axis}: ${a} + ${b}`).not.toBe(0)
    }
  })

  it('keeps each letter between 40% and 60% of all possible answer sheets', () => {
    for (const [position, axis] of AXES.entries()) {
      const left = results.filter((result) => result.preferenceCode[position] === axis[0]).length / results.length
      expect(left, `${axis[0]} share`).toBeGreaterThanOrEqual(0.4)
      expect(left, `${axis[0]} share`).toBeLessThanOrEqual(0.6)
    }
  })

  it('makes all 16 types reachable without any type crowding out the rest', () => {
    const counts = new Map<string, number>()
    for (const result of results) counts.set(result.preferenceCode, (counts.get(result.preferenceCode) ?? 0) + 1)
    expect(counts.size).toBe(16)
    const shares = [...counts.values()].map((count) => count / results.length)
    // An even spread is 6.25% each. Seven questions gave 11.4% (ESTJ) down to 2.9% (INFP).
    expect(Math.max(...shares)).toBeLessThanOrEqual(0.1)
    expect(Math.min(...shares)).toBeGreaterThanOrEqual(0.035)
  })

  it('labels a slightly inconsistent J or P person correctly at least 72% of the time', () => {
    // Per J/P question: 60% choose the option that strongly fits them, 25% the mild one, 15% the opposite.
    // With only q07 this was 85% for J but 60% for P.
    const items = weights('JP')
    for (const pole of ['J', 'P'] as const) {
      const direction = pole === 'P' ? 1 : -1
      let correct = 0
      const walk = (index: number, probability: number, total: number) => {
        if (index === items.length) { if ((total >= 0 ? 'P' : 'J') === pole) correct += probability; return }
        const ranked = [...items[index]].sort((a, b) => direction * b - direction * a)
        walk(index + 1, probability * 0.6, total + ranked[0])
        walk(index + 1, probability * 0.25, total + ranked[1])
        walk(index + 1, probability * 0.15, total + ranked[2])
      }
      walk(0, 1, 0)
      expect(correct, `true ${pole}`).toBeGreaterThanOrEqual(0.72)
    }
  })
})
