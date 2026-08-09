export const MBTI_DIMENSIONS = ['EI', 'SN', 'TF', 'JP'] as const
export const AIEQ_DIMENSIONS = [
  'ai_collaboration',
  'transition_speed',
  'ambiguity_tolerance',
  'agency',
  'verification',
  'continuous_learning',
] as const

export type MbtiDimension = (typeof MBTI_DIMENSIONS)[number]
export type AieqDimension = (typeof AIEQ_DIMENSIONS)[number]
export type ScoreDimension = MbtiDimension | AieqDimension

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

export interface MbtiPreferenceResult extends DimensionScore {
  dimension: MbtiDimension
  left: string
  right: string
  preference: string
  strength: number
}

export interface AieqAbilityResult extends DimensionScore {
  dimension: AieqDimension
}

export interface AssessmentResult {
  instrumentVersion: string
  preferenceCode: string
  mbtiPreferences: Record<MbtiDimension, MbtiPreferenceResult>
  aieqAbilities: Record<AieqDimension, AieqAbilityResult>
  overallConfidence: number
  disclaimer: string
}
