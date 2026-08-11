import type { AieqQuestion, AieqSession, AnswerEvent, RecordedAnswer } from './types.js'

export interface TransitionResult {
  session: AieqSession
  duplicate: boolean
  accepted: boolean
  reason?: string
}

export function createAieqSession(id: string, now = new Date().toISOString()): AieqSession {
  return {
    id,
    instrumentVersion: 'aieq-pilot-0.1',
    status: 'in_progress',
    currentQuestionIndex: 0,
    answers: {},
    processedEventIds: [],
    eventLog: [],
    personalizationConsent: false,
    startedAt: now,
    updatedAt: now,
  }
}

function cloneSession(session: AieqSession): AieqSession {
  return {
    ...session,
    answers: { ...session.answers },
    processedEventIds: [...session.processedEventIds],
    eventLog: [...session.eventLog],
  }
}

function recordEvent(session: AieqSession, event: AnswerEvent): void {
  session.processedEventIds.push(event.eventId)
  session.eventLog.push(event)
  session.updatedAt = event.occurredAt
}

function reject(session: AieqSession, reason: string): TransitionResult {
  return { session, duplicate: false, accepted: false, reason }
}

export function transitionAieqSession(
  current: AieqSession,
  event: AnswerEvent,
  questions: readonly AieqQuestion[],
): TransitionResult {
  if (event.sessionId !== current.id) return reject(current, 'session_mismatch')
  if (current.processedEventIds.includes(event.eventId)) {
    return { session: current, duplicate: true, accepted: true }
  }

  const session = cloneSession(current)

  if (event.kind === 'pause') {
    if (session.status !== 'completed') session.status = 'paused'
    recordEvent(session, event)
    return { session, duplicate: false, accepted: true }
  }

  if (event.kind === 'resume') {
    if (session.status === 'paused') session.status = 'in_progress'
    recordEvent(session, event)
    return { session, duplicate: false, accepted: true }
  }

  if (event.kind === 'back') {
    const priorIndex = questions
      .slice(0, session.currentQuestionIndex)
      .map((question, index) => ({ question, index }))
      .reverse()
      .find(({ question }) => session.answers[question.id] !== undefined)

    if (priorIndex) {
      delete session.answers[priorIndex.question.id]
      session.currentQuestionIndex = priorIndex.index
      session.status = 'in_progress'
      delete session.completedAt
    }
    recordEvent(session, event)
    return { session, duplicate: false, accepted: true }
  }

  if (session.status === 'paused') return reject(current, 'session_paused')
  if (session.status === 'completed') return reject(current, 'session_completed')

  const question = questions[session.currentQuestionIndex]
  if (!question) return reject(current, 'question_not_found')
  if (event.questionId !== question.id) return reject(current, 'unexpected_question')

  if (event.kind === 'answer' && event.optionId) {
    if (!question.options.some((option) => option.id === event.optionId)) {
      return reject(current, 'invalid_option')
    }
  }

  const answer: RecordedAnswer = {
    questionId: question.id,
    optionId: event.kind === 'answer' ? event.optionId : undefined,
    source: event.source,
    eventId: event.eventId,
    interpretationConfidence: Math.max(0, Math.min(1, event.interpretationConfidence ?? 1)),
    rawText: event.rawText,
  }
  session.answers[question.id] = answer
  session.currentQuestionIndex += 1
  recordEvent(session, event)

  if (session.currentQuestionIndex >= questions.length) {
    session.status = 'completed'
    session.completedAt = event.occurredAt
  }

  return { session, duplicate: false, accepted: true }
}

function normalize(text: string): string {
  return text.trim().toLocaleLowerCase('zh-TW').replace(/[\s，。！？、,.!?]/g, '')
}

export function freeTextToAnswerEvent(input: {
  eventId: string
  sessionId: string
  question: AieqQuestion
  rawText: string
  occurredAt?: string
}): AnswerEvent {
  const normalized = normalize(input.rawText)
  const uncertain = ['不知道', '不確定', '看情況', '都可以', '略過'].some((value) =>
    normalized.includes(normalize(value)),
  )

  if (uncertain) {
    return {
      eventId: input.eventId,
      sessionId: input.sessionId,
      source: 'free_text',
      kind: normalized.includes('略過') ? 'skip' : 'uncertain',
      questionId: input.question.id,
      rawText: input.rawText,
      interpretationConfidence: 1,
      occurredAt: input.occurredAt ?? new Date().toISOString(),
    }
  }

  const matches = input.question.options.filter((option) =>
    [option.id, option.shortLabel, option.label, ...(option.aliases ?? [])]
      .map(normalize)
      .some((candidate) => candidate.length > 0 && normalized.includes(candidate)),
  )

  return {
    eventId: input.eventId,
    sessionId: input.sessionId,
    source: 'free_text',
    kind: 'answer',
    questionId: input.question.id,
    optionId: matches.length === 1 ? matches[0].id : undefined,
    rawText: input.rawText,
    interpretationConfidence: matches.length === 1 ? 1 : 0,
    occurredAt: input.occurredAt ?? new Date().toISOString(),
  }
}
