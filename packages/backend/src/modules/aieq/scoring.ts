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
type Pole = { key: string; name: string; blurb: string }
const AXIS_POLES: Record<AxisId, { name: string; left: Pole; right: Pole }> = {
  energy: {
    name: '能量來源',
    left: { key: 'out', name: '向外', blurb: '跟人討論就會充電，想法愈講愈清楚' },
    right: { key: 'in', name: '向內', blurb: '獨處時最能回電，想法在心裡整理好才說出口' },
  },
  input: {
    name: '接收資訊',
    left: { key: 'real', name: '務實', blurb: '先看得到的事實與細節，一步一步確認' },
    right: { key: 'idea', name: '想像', blurb: '擅長跳躍聯想，先抓住整體的可能性' },
  },
  decide: {
    name: '做決定',
    left: { key: 'logic', name: '邏輯', blurb: '用證據和條件衡量，重視客觀與效率' },
    right: { key: 'feel', name: '感受', blurb: '先想到人的感受，在乎關係與價值' },
  },
  action: {
    name: '行動方式',
    left: { key: 'plan', name: '規劃', blurb: '凡事提前安排，照著進度把事情收尾' },
    right: { key: 'flex', name: '彈性', blurb: '保留變動空間，邊做邊調整找出路' },
  },
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
    poleBlurb: decided ? leaning.blurb : '這次的作答還不足以判斷這一條',
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
