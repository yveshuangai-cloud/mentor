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
  isAieqInfoText,
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

function runAnswers(optionIndex: 0 | 1 | 2): AieqSession {
  let session = createAieqSession(`session-${optionIndex}`, NOW)
  for (const [index, question] of AIEQ_QUESTIONS.entries()) {
    const result = transitionAieqSession(
      session,
      cardAnswer(session.id, `event-${optionIndex}-${index}`, question.id, question.options[optionIndex].id),
      AIEQ_QUESTIONS,
    )
    expect(result.accepted).toBe(true)
    session = result.session
  }
  return session
}

describe('AIEQ answer state machine', () => {
  it('uses the approved eight scenarios for a roughly one-minute assessment', () => {
    expect(AIEQ_QUESTIONS).toHaveLength(8)
  })

  it('uses eventId as an idempotency key for duplicate LINE postbacks', () => {
    const session = createAieqSession('session-1', NOW)
    const event = cardAnswer('session-1', 'line-event-1', AIEQ_QUESTIONS[0].id, AIEQ_QUESTIONS[0].options[0].id)

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
      cardAnswer(cardSession.id, 'card-1', question.id, question.options[0].id),
      AIEQ_QUESTIONS,
    ).session
    const textEvent = freeTextToAnswerEvent({
      eventId: 'text-1',
      sessionId: textSession.id,
      question,
      rawText: '我很期待去嘗試。',
      occurredAt: NOW,
    })
    const text = transitionAieqSession(textSession, textEvent, AIEQ_QUESTIONS).session

    expect(textEvent.optionId).toBe('try')
    expect(text.answers[question.id].optionId).toBe(card.answers[question.id].optionId)
    expect(Math.sign(scoreAssessment(text).axes.input.balance)).toBe(
      Math.sign(scoreAssessment(card).axes.input.balance),
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
    expect(scoreAssessment(result.session).axes.input.evidenceCount).toBe(0)
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
      cardAnswer(session.id, 'blocked-answer', AIEQ_QUESTIONS[1].id, AIEQ_QUESTIONS[1].options[1].id),
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
    const session = runAnswers(1)
    expect(session.status).toBe('completed')
    expect(session.currentQuestionIndex).toBe(AIEQ_QUESTIONS.length)
    expect(session.completedAt).toBe(NOW)
  })
})

describe('AIEQ scoring boundaries', () => {
  it('matches the approved axis coverage and records the new instrument version', () => {
    expect(AIEQ_QUESTIONS.filter((q) => q.dimensions.includes('energy'))).toHaveLength(2)
    expect(AIEQ_QUESTIONS.filter((q) => q.dimensions.includes('input'))).toHaveLength(2)
    expect(AIEQ_QUESTIONS.filter((q) => q.dimensions.includes('decide'))).toHaveLength(2)
    expect(AIEQ_QUESTIONS.filter((q) => q.dimensions.includes('action'))).toHaveLength(2)
    expect(createAieqSession('version-check', NOW).instrumentVersion).toBe('ai-personality-1.1-8q')
  })

  it('reproduces the meeting ENTP example with PPT clarity formula', () => {
    // The first seven answers are the example from the 2026-09-11 meeting deck. Question 8 did not exist then;
    // the example person is a clear P, so they get the P answer and J/P stays (2+3)/(2+3) = 100.
    const optionIds = ['try', 'angle', 'story', 'retry', 'usable', 'wait', 'spontaneous', 'more']
    let session = createAieqSession('meeting-example', NOW)
    AIEQ_QUESTIONS.forEach((question, index) => {
      session = transitionAieqSession(
        session,
        cardAnswer(session.id, `meeting-${index}`, question.id, optionIds[index]),
        AIEQ_QUESTIONS,
      ).session
    })
    const result = scoreAssessment(session)
    expect(result.typeKey).toBe('out-idea-logic-flex')
    expect(result.axes.energy.strength).toBe(25)
    expect(result.axes.input.strength).toBe(100)
    expect(result.axes.decide.strength).toBe(70)
    expect(result.axes.action.strength).toBe(100)
  })

  it('does not derive AI capability from an preference axis', () => {
    const independentQuestion: AieqQuestion = {
      id: 'independent',
      scenario: '同一個內向偏好的人可能採取不同協作策略。',
      prompt: '你會怎麼做？',
      validation: 'direct',
      dimensions: ['energy', 'ai_collaboration'],
      options: [
        { id: 'a', shortLabel: '策略 A', label: '策略 A', evidence: { energy: 1, ai_collaboration: 1 } },
        { id: 'b', shortLabel: '策略 B', label: '策略 B', evidence: { energy: 1, ai_collaboration: -1 } },
        { id: 'c', shortLabel: '策略 C', label: '策略 C', evidence: { energy: -1, ai_collaboration: 0 } },
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

    expect(resultA.axes.energy.pole).toBe('in')
    expect(resultB.axes.energy.pole).toBe('in')
    expect(resultA.axes.energy.poleName).toBe('向內')
    expect(resultA.aieqAbilities.ai_collaboration.score).toBe(100)
    expect(resultB.aieqAbilities.ai_collaboration.score).toBe(0)
  })

  it('reports confidence and lowers it when evidence is missing', () => {
    const complete = scoreAssessment(runAnswers(1))
    let partialSession = createAieqSession('partial', NOW)
    partialSession = transitionAieqSession(
      partialSession,
      cardAnswer(partialSession.id, 'partial-1', AIEQ_QUESTIONS[0].id, AIEQ_QUESTIONS[0].options[1].id),
      AIEQ_QUESTIONS,
    ).session
    const partial = scoreAssessment(partialSession)

    expect(complete.overallConfidence).toBeGreaterThan(partial.overallConfidence)
    expect(complete.disclaimer).toContain('不是心理診斷')
    expect(complete.disclaimer).not.toMatch(/MBTI|Myers/i)
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
    expect(scoredButtons[0].action?.data).toContain('question_id=q01_ai_trend')
  })

  it('builds a neutral report with confidence and no visual hierarchy', () => {
    const report = buildResultReport(scoreAssessment(runAnswers(0)))

    expect(report.strongestSignals).toHaveLength(2)
    expect(report.growthExperiments).toHaveLength(2)
    expect(report.confidenceNote).toContain('信心程度')
    expect(report.disclaimer).toContain('不是心理診斷')
    expect(report.disclaimer).not.toMatch(/MBTI|Myers/i)
    expect(JSON.stringify(report)).not.toMatch(/稀有|高階|低階|淘汰/)
  })

  it('builds a LINE result card that opens the LIFF confirmation layer', () => {
    const result = scoreAssessment(runAnswers(0))
    const flex = buildResultFlex(result, 'https://example.test')
    const serialized = JSON.stringify(flex)
    expect(serialized).toContain('https://example.test/aieq')
    expect(serialized).toContain('非心理診斷')
    expect(serialized).not.toMatch(/MBTI|Myers/i)
    // The internal key never leaves the server; the familiar shorthand may, in a supporting role.
    expect(serialized).not.toContain('in-idea-feel-plan')
    expect(serialized).toContain('INFJ')
  })

  it('only starts from explicit AIEQ phrases', () => {
    expect(isAieqStartText('開始 AIEQ')).toBe(true)
    expect(isAieqStartText('繼續AIEQ')).toBe(true)
    expect(isAieqStartText('開始 AI人格誌')).toBe(true)
    expect(isAieqStartText('AI人格誌')).toBe(false)
    expect(isAieqInfoText('AI人格誌')).toBe(true)
    expect(isAieqInfoText('AIEQ')).toBe(true)
    expect(isAieqStartText('我今天心情不錯')).toBe(false)
    expect(isAieqStartText('重測 AIEQ')).toBe(false)
  })
})
