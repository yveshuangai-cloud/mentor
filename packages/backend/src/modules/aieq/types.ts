// Four preference axes, named in this product's own vocabulary. The scoring maths is unchanged;
// only the naming is ours, so nothing here leans on another instrument's terminology.
export const PREFERENCE_AXES = ['energy', 'input', 'decide', 'action'] as const
export const AIEQ_DIMENSIONS = [
  'ai_collaboration',
  'transition_speed',
  'ambiguity_tolerance',
  'agency',
  'verification',
  'continuous_learning',
] as const

export type AxisId = (typeof PREFERENCE_AXES)[number]
export type AieqDimension = (typeof AIEQ_DIMENSIONS)[number]
export type ScoreDimension = AxisId | AieqDimension

export interface QuestionOption {
  id: string
  label: string
  shortLabel: string
  aliases?: string[]
  /** Signed evidence only. Positive/negative is a direction, never good/bad. */
  evidence: Partial<Record<ScoreDimension, number>>
}

export interface AieqQuestion {
  id: string
  prompt: string
  scenario: string
  options: [QuestionOption, QuestionOption, QuestionOption]
  validation: 'direct' | 'reverse' | 'cross_check'
  dimensions: ScoreDimension[]
}

export type AnswerSource = 'card' | 'free_text' | 'system'
export type AnswerKind = 'answer' | 'uncertain' | 'skip' | 'back' | 'pause' | 'resume'

export interface AnswerEvent {
  eventId: string
  sessionId: string
  source: AnswerSource
  kind: AnswerKind
  occurredAt: string
  questionId?: string
  optionId?: string
  rawText?: string
  /** 0..1: certainty of the input interpretation, not personality certainty. */
  interpretationConfidence?: number
}

export interface RecordedAnswer {
  questionId: string
  optionId?: string
  source: AnswerSource
  eventId: string
  interpretationConfidence: number
  rawText?: string
}

export type AieqSessionStatus = 'in_progress' | 'paused' | 'completed'

export interface AieqSession {
  id: string
  instrumentVersion: string
  status: AieqSessionStatus
  currentQuestionIndex: number
  answers: Record<string, RecordedAnswer>
  processedEventIds: string[]
  eventLog: AnswerEvent[]
  /** Results stay isolated unless this is explicitly granted by the user. */
  personalizationConsent: boolean
  startedAt: string
  updatedAt: string
  completedAt?: string
}

export interface DimensionScore {
  dimension: ScoreDimension
  balance: number
  score: number
  confidence: number
  evidenceCount: number
  observedWeight: number
}

export interface AxisResult extends DimensionScore {
  dimension: AxisId
  /** Plain-language name of the axis, e.g. 能量來源. */
  axisName: string
  /** Machine key of the leaning pole, e.g. 'out'; 'unknown' when there is no evidence. */
  pole: string
  /** Plain-language name of the leaning pole, e.g. 向外. */
  poleName: string
  strength: number
}

export interface AieqAbilityResult extends DimensionScore {
  dimension: AieqDimension
}

export interface AssessmentResult {
  instrumentVersion: string
  /** Internal key for the 16 combinations, e.g. 'out-idea-logic-flex'. Never shown to players. */
  typeKey: string
  axes: Record<AxisId, AxisResult>
  aieqAbilities: Record<AieqDimension, AieqAbilityResult>
  overallConfidence: number
  disclaimer: string
}
