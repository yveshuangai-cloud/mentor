import { config } from '../../config.js'
import type { LineMessage } from '../line.js'
import { buildResultFlex, buildThreeChoiceFlex } from './flex.js'
import { AIEQ_QUESTIONS } from './questions.js'
import { appendEvent, findActiveSession, findOrCreateSession, getConfirmedProfileSession, getSession } from './repository.js'
import { freeTextToAnswerEvent } from './stateMachine.js'
import { scoreAssessment } from './scoring.js'

const START_RE = /^(?:開始|我要測|繼續)?\s*(?:AIEQ|AI\s*EQ|AI人格測驗|AI時代人格)(?:測驗|測評)?[！!。\s]*$/i
const PAUSE_RE = /^(?:暫停|先休息|中斷)(?:測驗|測評)?$/
const RESUME_RE = /^(?:繼續|繼續作答|恢復)(?:測驗|測評)?$/
const BACK_RE = /^(?:上一題|回上一題|修改上一題)$/

function questionMessage(sessionId: string, index: number): LineMessage {
  const question = AIEQ_QUESTIONS[index]
  return {
    type: 'flex',
    altText: `AIEQ 第 ${index + 1} 題：${question.prompt}`,
    contents: buildThreeChoiceFlex(sessionId, question),
  }
}

function resultMessages(session: Awaited<ReturnType<typeof findOrCreateSession>>): LineMessage[] {
  const result = scoreAssessment(session)
  return [{
    type: 'flex',
    altText: `你的 AIEQ 結果：${result.preferenceCode}`,
    contents: buildResultFlex(
      result,
      config.publicBaseUrl,
      config.liffId === 'not-configured' ? `${config.publicBaseUrl}/aieq` : `https://liff.line.me/${config.liffId}`,
    ),
  }]
}

function nextMessages(session: Awaited<ReturnType<typeof findOrCreateSession>>): LineMessage[] {
  if (session.status === 'completed') return resultMessages(session)
  if (session.status === 'paused') return [{ type: 'text', text: '已暫停。下次跟我說「繼續 AIEQ」，我會從這一題接回來。' }]
  return [questionMessage(session.id, session.currentQuestionIndex)]
}

export async function startAieq(userId: number, tenantId?: number): Promise<LineMessage[]> {
  const confirmed = await getConfirmedProfileSession(userId)
  if (confirmed) return resultMessages(confirmed)
  const session = await findOrCreateSession(userId, tenantId)
  if (session.status === 'paused') {
    const transition = await appendEvent(userId, {
      eventId: `resume:${session.id}:${Date.now()}`,
      sessionId: session.id,
      source: 'system',
      kind: 'resume',
      occurredAt: new Date().toISOString(),
    })
    return nextMessages(transition.session)
  }
  return nextMessages(session)
}

export async function handleAieqText(input: {
  userId: number
  tenantId?: number
  text: string
  eventId: string
}): Promise<LineMessage[] | null> {
  if (START_RE.test(input.text) || RESUME_RE.test(input.text)) return startAieq(input.userId, input.tenantId)
  const session = await findActiveSession(input.userId)
  if (!session) return null
  if (session.status === 'completed') return null

  let event
  if (PAUSE_RE.test(input.text)) event = {
    eventId: input.eventId, sessionId: session.id, source: 'free_text' as const,
    kind: 'pause' as const, occurredAt: new Date().toISOString(), rawText: input.text,
  }
  else if (BACK_RE.test(input.text)) event = {
    eventId: input.eventId, sessionId: session.id, source: 'free_text' as const,
    kind: 'back' as const, occurredAt: new Date().toISOString(), rawText: input.text,
  }
  else {
    const question = AIEQ_QUESTIONS[session.currentQuestionIndex]
    event = freeTextToAnswerEvent({ eventId: input.eventId, sessionId: session.id, question, rawText: input.text })
    if (event.kind === 'answer' && !event.optionId) {
      return [
        { type: 'text', text: '我還不能確定你比較接近哪個選項。可以換個方式說，或直接點下面最接近的一項。' },
        questionMessage(session.id, session.currentQuestionIndex),
      ]
    }
  }
  const transition = await appendEvent(input.userId, event)
  return nextMessages(transition.session)
}

export async function handleAieqPostback(input: {
  userId: number
  data: string
  eventId: string
}): Promise<LineMessage[] | null> {
  const params = new URLSearchParams(input.data)
  const action = params.get('action')
  if (!action?.startsWith('aieq_')) return null
  const sessionId = params.get('session_id')
  if (!sessionId) return [{ type: 'text', text: '這張卡片已經失效，請跟我說「繼續 AIEQ」。' }]
  const session = await getSession(input.userId, sessionId)
  if (!session) return [{ type: 'text', text: '找不到這次測評，請跟我說「開始 AIEQ」。' }]
  const kind = action === 'aieq_answer' ? 'answer' : action === 'aieq_back' ? 'back' : 'uncertain'
  const transition = await appendEvent(input.userId, {
    eventId: input.eventId,
    sessionId,
    source: 'card',
    kind,
    questionId: params.get('question_id') ?? undefined,
    optionId: params.get('option_id') ?? undefined,
    occurredAt: new Date().toISOString(),
    interpretationConfidence: 1,
  })
  if (!transition.accepted) {
    if (transition.reason === 'unexpected_question' || transition.reason === 'session_completed') {
      return [{ type: 'text', text: '你點到較早的卡片了，我接著目前進度繼續。' }, ...nextMessages(transition.session)]
    }
    return [{ type: 'text', text: '這次操作沒有套用，請再試一次。' }]
  }
  return nextMessages(transition.session)
}

export function isAieqStartText(text: string): boolean {
  return START_RE.test(text) || RESUME_RE.test(text)
}
