import { AIEQ_QUESTIONS } from './questions.js'
import {
  AIEQ_DIMENSIONS,
  PREFERENCE_AXES,
  type AieqAbilityResult,
  type AieqDimension,
  type AieqQuestion,
  type AieqSession,
  type AssessmentResult,
  type DimensionScore,
  type AxisId,
  type AxisResult,
  type ScoreDimension,
} from './types.js'

// Each axis runs between two poles described in plain Chinese. A negative balance leans left, a positive one right.
const AXIS_POLES: Record<AxisId, { name: string; left: { key: string; name: string }; right: { key: string; name: string } }> = {
  energy: { name: '能量來源', left: { key: 'out', name: '向外' }, right: { key: 'in', name: '向內' } },
  input: { name: '接收資訊', left: { key: 'real', name: '務實' }, right: { key: 'idea', name: '想像' } },
  decide: { name: '做決定', left: { key: 'logic', name: '邏輯' }, right: { key: 'feel', name: '感受' } },
  action: { name: '行動方式', left: { key: 'plan', name: '規劃' }, right: { key: 'flex', name: '彈性' } },
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

function availableWeight(dimension: ScoreDimension, questions: readonly AieqQuestion[]): number {
  return questions.reduce((total, question) => {
    const strongestOption = Math.max(
      0,
      ...question.options.map((option) => Math.abs(option.evidence[dimension] ?? 0)),
    )
    return total + strongestOption
  }, 0)
}

function dimensionScore(
  dimension: ScoreDimension,
  session: AieqSession,
  questions: readonly AieqQuestion[],
): DimensionScore {
  let signedEvidence = 0
  let observedWeight = 0
  let rawWeight = 0
  let certaintyWeight = 0
  let evidenceCount = 0

  for (const question of questions) {
    const answer = session.answers[question.id]
    if (!answer?.optionId) continue
    const selected = question.options.find((option) => option.id === answer.optionId)
    const signal = selected?.evidence[dimension]
    if (signal === undefined || signal === 0) continue

    const magnitude = Math.abs(signal)
    const certainty = clamp(answer.interpretationConfidence, 0, 1)
    signedEvidence += signal * certainty
    observedWeight += magnitude * certainty
    rawWeight += magnitude
    certaintyWeight += magnitude * certainty
    evidenceCount += 1
  }

  const balance = observedWeight > 0 ? clamp(signedEvidence / observedWeight, -1, 1) : 0
  const coverage = clamp(observedWeight / Math.max(availableWeight(dimension, questions) * 0.7, 1), 0, 1)
  const interpretationCertainty = rawWeight > 0 ? clamp(certaintyWeight / rawWeight, 0, 1) : 0
  const directionalConsistency = 0.5 + Math.abs(balance) * 0.5
  const confidence = coverage * interpretationCertainty * directionalConsistency

  return {
    dimension,
    balance: round(balance),
    score: round(50 + balance * 50),
    confidence: round(confidence),
    evidenceCount,
    observedWeight: round(observedWeight),
  }
}

function axisResult(
  dimension: AxisId,
  session: AieqSession,
  questions: readonly AieqQuestion[],
): AxisResult {
  const base = dimensionScore(dimension, session, questions)
  const poles = AXIS_POLES[dimension]
  const signedScore = questions.reduce((total, question) => {
    const answer = session.answers[question.id]
    const selected = answer?.optionId
      ? question.options.find((option) => option.id === answer.optionId)
      : undefined
    return total + (selected?.evidence[dimension] ?? 0) * (answer?.interpretationConfidence ?? 0)
  }, 0)
  const clarity = round(clamp(Math.abs(signedScore) / Math.max(availableWeight(dimension, questions), 1), 0, 1))
  const leaning = base.balance >= 0 ? poles.right : poles.left
  const decided = base.evidenceCount > 0
  return {
    ...base,
    dimension,
    axisName: poles.name,
    confidence: clarity,
    pole: decided ? leaning.key : 'unknown',
    poleName: decided ? leaning.name : '還看不出來',
    strength: round(clarity * 100),
  }
}

export function scoreAssessment(
  session: AieqSession,
  questions: readonly AieqQuestion[] = AIEQ_QUESTIONS,
): AssessmentResult {
  const axes = Object.fromEntries(
    PREFERENCE_AXES.map((dimension) => [dimension, axisResult(dimension, session, questions)]),
  ) as Record<AxisId, AxisResult>

  const aieqAbilities = Object.fromEntries(
    AIEQ_DIMENSIONS.map((dimension) => [
      dimension,
      { ...dimensionScore(dimension, session, questions), dimension } satisfies AieqAbilityResult,
    ]),
  ) as Record<AieqDimension, AieqAbilityResult>

  const allScores = Object.values(axes)
  const overallConfidence =
    allScores.length === 0
      ? 0
      : round(allScores.reduce((total, result) => total + result.confidence, 0) / allScores.length)

  return {
    instrumentVersion: session.instrumentVersion,
    typeKey: PREFERENCE_AXES.map((dimension) => axes[dimension].pole).join('-'),
    axes,
    aieqAbilities,
    overallConfidence,
    disclaimer: 'AI 人格誌是描述你目前與 AI 相處傾向的情境快篩，不是心理診斷，也不評量能力高低。',
  }
}
