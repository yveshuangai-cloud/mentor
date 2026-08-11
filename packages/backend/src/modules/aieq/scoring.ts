import { AIEQ_QUESTIONS } from './questions.js'
import {
  AIEQ_DIMENSIONS,
  MBTI_DIMENSIONS,
  type AieqAbilityResult,
  type AieqDimension,
  type AieqQuestion,
  type AieqSession,
  type AssessmentResult,
  type DimensionScore,
  type MbtiDimension,
  type MbtiPreferenceResult,
  type ScoreDimension,
} from './types.js'

const MBTI_POLES: Record<MbtiDimension, { left: string; right: string }> = {
  EI: { left: 'E', right: 'I' },
  SN: { left: 'S', right: 'N' },
  TF: { left: 'T', right: 'F' },
  JP: { left: 'J', right: 'P' },
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

function mbtiResult(
  dimension: MbtiDimension,
  session: AieqSession,
  questions: readonly AieqQuestion[],
): MbtiPreferenceResult {
  const base = dimensionScore(dimension, session, questions)
  const poles = MBTI_POLES[dimension]
  return {
    ...base,
    dimension,
    ...poles,
    preference: base.evidenceCount === 0 ? 'X' : base.balance >= 0 ? poles.right : poles.left,
    strength: round(Math.abs(base.balance) * 100),
  }
}

export function scoreAssessment(
  session: AieqSession,
  questions: readonly AieqQuestion[] = AIEQ_QUESTIONS,
): AssessmentResult {
  const mbtiPreferences = Object.fromEntries(
    MBTI_DIMENSIONS.map((dimension) => [dimension, mbtiResult(dimension, session, questions)]),
  ) as Record<MbtiDimension, MbtiPreferenceResult>

  const aieqAbilities = Object.fromEntries(
    AIEQ_DIMENSIONS.map((dimension) => [
      dimension,
      { ...dimensionScore(dimension, session, questions), dimension } satisfies AieqAbilityResult,
    ]),
  ) as Record<AieqDimension, AieqAbilityResult>

  const allScores = [...Object.values(mbtiPreferences), ...Object.values(aieqAbilities)]
  const overallConfidence =
    allScores.length === 0
      ? 0
      : round(allScores.reduce((total, result) => total + result.confidence, 0) / allScores.length)

  return {
    instrumentVersion: session.instrumentVersion,
    preferenceCode: MBTI_DIMENSIONS.map((dimension) => mbtiPreferences[dimension].preference).join(''),
    mbtiPreferences,
    aieqAbilities,
    overallConfidence,
    disclaimer:
      'AIEQ 是參考四組人格偏好的 AI 時代行為傾向測評，非心理診斷，也不是官方 MBTI® 測驗。',
  }
}
