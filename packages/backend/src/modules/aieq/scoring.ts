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
type Pole = { key: string; letter: string; name: string; blurb: string }
// Names and descriptions are the chief planner's own, from AI Personality V.4 (2026-09-19).
// The letter is the familiar shorthand; the name and the line under it are what it means here.
const AXIS_POLES: Record<AxisId, { name: string; left: Pole; right: Pole }> = {
  energy: {
    name: '協作方法',
    left: { key: 'out', letter: 'E', name: '外部共創', blurb: '透過團隊互動、召集與外部回饋來推進工作' },
    right: { key: 'in', letter: 'I', name: '獨立深思', blurb: '先獨立研究、完成原型後再與人分享' },
  },
  input: {
    name: '思考方式',
    left: { key: 'real', letter: 'S', name: '實證拆解', blurb: '專注於具體操作、資料拆解與可觀察的錯誤' },
    right: { key: 'idea', letter: 'N', name: '全局模式', blurb: '從整體架構、小規模實驗與未來可能性切入' },
  },
  decide: {
    name: '決策基準',
    left: { key: 'logic', letter: 'T', name: '原則測試', blurb: '依靠客觀數據、測試標準與風險門檻做決定' },
    right: { key: 'feel', letter: 'F', name: '人際共感', blurb: '優先考量人的顧慮、情境影響與團隊共識' },
  },
  action: {
    name: '積極態度',
    left: { key: 'plan', letter: 'J', name: '結構收斂', blurb: '習慣先定義範圍、重排行程與建立檢查點' },
    right: { key: 'flex', letter: 'P', name: '彈性探索', blurb: '喜歡邊做邊改，透過回饋逐步收斂未知路徑' },
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
    poleLetter: decided ? leaning.letter : 'X',
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
