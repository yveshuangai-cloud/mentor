import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  AIEQ_ANIMALS,
  AIEQ_QUESTIONS,
  buildResultReport,
  buildThreeChoiceFlex,
  buildResultFlex,
  createAieqSession,
  freeTextToAnswerEvent,
  scoreAssessment,
  isAieqStartText,
  transitionAieqSession,
  type AieqQuestion,
  type AieqSession,
  type AnswerEvent,
} from '../src/modules/aieq/index.js'

const NOW = '2026-08-09T10:00:00.000Z'

function cardAnswer(
  sessionId: string,
  eventId: string,
  questionId: string,
  optionId: string,
): AnswerEvent {
  return {
    eventId,
    sessionId,
    source: 'card',
    kind: 'answer',
    occurredAt: NOW,
    questionId,
    optionId,
    interpretationConfidence: 1,
  }
}

function runAnswers(optionId: 'a' | 'b' | 'c'): AieqSession {
  let session = createAieqSession(`session-${optionId}`, NOW)
  for (const [index, question] of AIEQ_QUESTIONS.entries()) {
    const result = transitionAieqSession(
      session,
      cardAnswer(session.id, `event-${optionId}-${index}`, question.id, optionId),
      AIEQ_QUESTIONS,
    )
    expect(result.accepted).toBe(true)
    session = result.session
  }
  return session
}

describe('AIEQ answer state machine', () => {
  it('uses eight core scenarios for a two-minute assessment', () => {
    expect(AIEQ_QUESTIONS).toHaveLength(8)
  })

  it('uses eventId as an idempotency key for duplicate LINE postbacks', () => {
    const session = createAieqSession('session-1', NOW)
    const event = cardAnswer('session-1', 'line-event-1', AIEQ_QUESTIONS[0].id, 'a')

    const first = transitionAieqSession(session, event, AIEQ_QUESTIONS)
    const duplicate = transitionAieqSession(first.session, event, AIEQ_QUESTIONS)

    expect(first.accepted).toBe(true)
    expect(first.session.currentQuestionIndex).toBe(1)
    expect(duplicate.duplicate).toBe(true)
    expect(duplicate.session.currentQuestionIndex).toBe(1)
    expect(duplicate.session.eventLog).toHaveLength(1)
  })

  it('normalizes card and unambiguous natural-language answers to the same option', () => {
    const question = AIEQ_QUESTIONS[0]
    const cardSession = createAieqSession('card-session', NOW)
    const textSession = createAieqSession('text-session', NOW)

    const card = transitionAieqSession(
      cardSession,
      cardAnswer(cardSession.id, 'card-1', question.id, 'a'),
      AIEQ_QUESTIONS,
    ).session
    const textEvent = freeTextToAnswerEvent({
      eventId: 'text-1',
      sessionId: textSession.id,
      question,
      rawText: '我會先做小實驗，再看看結果。',
      occurredAt: NOW,
    })
    const text = transitionAieqSession(textSession, textEvent, AIEQ_QUESTIONS).session

    expect(textEvent.optionId).toBe('a')
    expect(text.answers[question.id].optionId).toBe(card.answers[question.id].optionId)
    expect(Math.sign(scoreAssessment(text).mbtiPreferences.SN.balance)).toBe(
      Math.sign(scoreAssessment(card).mbtiPreferences.SN.balance),
    )
  })

  it('keeps ambiguous free text without guessing a score', () => {
    const question = AIEQ_QUESTIONS[0]
    const session = createAieqSession('ambiguous-session', NOW)
    const event = freeTextToAnswerEvent({
      eventId: 'text-ambiguous',
      sessionId: session.id,
      question,
      rawText: '我要看當時的專案狀況。',
      occurredAt: NOW,
    })
    const result = transitionAieqSession(session, event, AIEQ_QUESTIONS)

    expect(event.optionId).toBeUndefined()
    expect(event.interpretationConfidence).toBe(0)
    expect(result.session.answers[question.id].rawText).toContain('專案狀況')
    expect(scoreAssessment(result.session).mbtiPreferences.SN.evidenceCount).toBe(0)
  })

  it('supports uncertain, skip, back, pause, and resume in the same event format', () => {
    let session = createAieqSession('session-controls', NOW)

    session = transitionAieqSession(
      session,
      {
        eventId: 'uncertain-1',
        sessionId: session.id,
        source: 'card',
        kind: 'uncertain',
        questionId: AIEQ_QUESTIONS[0].id,
        occurredAt: NOW,
      },
      AIEQ_QUESTIONS,
    ).session
    expect(session.currentQuestionIndex).toBe(1)

    session = transitionAieqSession(
      session,
      { eventId: 'pause-1', sessionId: session.id, source: 'system', kind: 'pause', occurredAt: NOW },
      AIEQ_QUESTIONS,
    ).session
    const whilePaused = transitionAieqSession(
      session,
      cardAnswer(session.id, 'blocked-answer', AIEQ_QUESTIONS[1].id, 'b'),
      AIEQ_QUESTIONS,
    )
    expect(whilePaused.accepted).toBe(false)
    expect(whilePaused.reason).toBe('session_paused')

    session = transitionAieqSession(
      session,
      { eventId: 'resume-1', sessionId: session.id, source: 'system', kind: 'resume', occurredAt: NOW },
      AIEQ_QUESTIONS,
    ).session
    session = transitionAieqSession(
      session,
      {
        eventId: 'skip-2',
        sessionId: session.id,
        source: 'free_text',
        kind: 'skip',
        questionId: AIEQ_QUESTIONS[1].id,
        rawText: '略過',
        occurredAt: NOW,
      },
      AIEQ_QUESTIONS,
    ).session
    expect(session.currentQuestionIndex).toBe(2)

    session = transitionAieqSession(
      session,
      { eventId: 'back-1', sessionId: session.id, source: 'card', kind: 'back', occurredAt: NOW },
      AIEQ_QUESTIONS,
    ).session
    expect(session.currentQuestionIndex).toBe(1)
    expect(session.answers[AIEQ_QUESTIONS[1].id]).toBeUndefined()
    expect(session.eventLog.map((event) => event.kind)).toEqual([
      'uncertain',
      'pause',
      'resume',
      'skip',
      'back',
    ])
  })

  it('marks a session complete only after the final question', () => {
    const session = runAnswers('b')
    expect(session.status).toBe('completed')
    expect(session.currentQuestionIndex).toBe(AIEQ_QUESTIONS.length)
    expect(session.completedAt).toBe(NOW)
  })
})

describe('AIEQ scoring boundaries', () => {
  it('has repeated, differently keyed evidence for every dimension', () => {
    const dimensions = ['EI', 'SN', 'TF', 'JP'] as const
    for (const dimension of dimensions) {
      const questions = AIEQ_QUESTIONS.filter((question) => question.dimensions.includes(dimension))
      expect(questions.length).toBeGreaterThanOrEqual(2)
      expect(new Set(questions.map((question) => question.validation)).size).toBeGreaterThanOrEqual(2)
    }

    const abilityDimensions = [
      'ai_collaboration',
      'transition_speed',
      'ambiguity_tolerance',
      'agency',
      'verification',
      'continuous_learning',
    ] as const
    for (const dimension of abilityDimensions) {
      expect(AIEQ_QUESTIONS.filter((question) => question.dimensions.includes(dimension)).length).toBeGreaterThanOrEqual(3)
    }
  })

  it('does not derive AI capability from an MBTI preference', () => {
    const independentQuestion: AieqQuestion = {
      id: 'independent',
      scenario: '同一個內向偏好的人可能採取不同協作策略。',
      prompt: '你會怎麼做？',
      validation: 'direct',
      dimensions: ['EI', 'ai_collaboration'],
      options: [
        { id: 'a', shortLabel: '策略 A', label: '策略 A', evidence: { EI: 1, ai_collaboration: 1 } },
        { id: 'b', shortLabel: '策略 B', label: '策略 B', evidence: { EI: 1, ai_collaboration: -1 } },
        { id: 'c', shortLabel: '策略 C', label: '策略 C', evidence: { EI: -1, ai_collaboration: 0 } },
      ],
    }
    const questions = [independentQuestion]
    const sessionA = transitionAieqSession(
      createAieqSession('independent-a', NOW),
      cardAnswer('independent-a', 'ia', 'independent', 'a'),
      questions,
    ).session
    const sessionB = transitionAieqSession(
      createAieqSession('independent-b', NOW),
      cardAnswer('independent-b', 'ib', 'independent', 'b'),
      questions,
    ).session
    const resultA = scoreAssessment(sessionA, questions)
    const resultB = scoreAssessment(sessionB, questions)

    expect(resultA.mbtiPreferences.EI.preference).toBe('I')
    expect(resultB.mbtiPreferences.EI.preference).toBe('I')
    expect(resultA.aieqAbilities.ai_collaboration.score).toBe(100)
    expect(resultB.aieqAbilities.ai_collaboration.score).toBe(0)
  })

  it('reports confidence and lowers it when evidence is missing', () => {
    const complete = scoreAssessment(runAnswers('b'))
    let partialSession = createAieqSession('partial', NOW)
    partialSession = transitionAieqSession(
      partialSession,
      cardAnswer(partialSession.id, 'partial-1', AIEQ_QUESTIONS[0].id, 'b'),
      AIEQ_QUESTIONS,
    ).session
    const partial = scoreAssessment(partialSession)

    expect(complete.overallConfidence).toBeGreaterThan(partial.overallConfidence)
    expect(complete.disclaimer).toContain('不是官方 MBTI')
  })
})

describe('AIEQ presentation prototypes', () => {
  it('maps all 16 preference codes to distinct production animal assets', () => {
    const animals = Object.values(AIEQ_ANIMALS)
    expect(animals).toHaveLength(16)
    expect(new Set(animals.map((animal) => animal.slug)).size).toBe(16)
    for (const animal of animals) {
      expect(existsSync(resolve('../..', `assets/aieq${animal.imagePath.replace('/aieq/assets', '')}`))).toBe(true)
      expect(animal.strength).not.toBe('')
      expect(animal.blindSpot).not.toBe('')
      expect(animal.growthRoute).not.toBe('')
    }
  })

  it('builds one LINE Flex card with exactly three scored choices', () => {
    const flex = buildThreeChoiceFlex('demo-session', AIEQ_QUESTIONS[0]) as {
      body: { contents: Array<{ type: string; action?: { data?: string } }> }
    }
    const scoredButtons = flex.body.contents.filter((content) =>
      content.action?.data?.includes('action=aieq_answer'),
    )

    expect(scoredButtons).toHaveLength(3)
    expect(scoredButtons[0].action?.data).toContain('session_id=demo-session')
    expect(scoredButtons[0].action?.data).toContain('question_id=q01_new_tool')
  })

  it('builds a neutral report with confidence and no visual hierarchy', () => {
    const report = buildResultReport(scoreAssessment(runAnswers('a')))

    expect(report.strongestSignals).toHaveLength(2)
    expect(report.growthExperiments).toHaveLength(2)
    expect(report.confidenceNote).toContain('信心程度')
    expect(report.disclaimer).toContain('非心理診斷')
    expect(JSON.stringify(report)).not.toMatch(/稀有|高階|低階|淘汰/)
  })

  it('builds a LINE result card that opens the LIFF confirmation layer', () => {
    const result = scoreAssessment(runAnswers('a'))
    const flex = buildResultFlex(result, 'https://example.test')
    const serialized = JSON.stringify(flex)
    expect(serialized).toContain('https://example.test/aieq')
    expect(serialized).toContain(result.preferenceCode)
    expect(serialized).toContain('非心理診斷')
  })

  it('only starts from explicit AIEQ phrases', () => {
    expect(isAieqStartText('開始 AIEQ')).toBe(true)
    expect(isAieqStartText('繼續AIEQ')).toBe(true)
    expect(isAieqStartText('我今天心情不錯')).toBe(false)
    expect(isAieqStartText('重測 AIEQ')).toBe(false)
  })
})
