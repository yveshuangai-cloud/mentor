import type { AieqDimension, AssessmentResult } from './types.js'

const ABILITY_LABELS: Record<AieqDimension, string> = {
  ai_collaboration: 'AI 協作',
  transition_speed: '轉型速度',
  ambiguity_tolerance: '模糊容忍',
  agency: '主動性',
  verification: '驗證能力',
  continuous_learning: '持續學習',
}

export interface ResultReportPrototype {
  title: string
  summary: string
  preferenceNote: string
  strongestSignals: string[]
  growthExperiments: string[]
  confidenceNote: string
  disclaimer: string
}

export function buildResultReport(result: AssessmentResult): ResultReportPrototype {
  const ranked = Object.values(result.aieqAbilities).sort((a, b) => b.score - a.score)
  const strongestSignals = ranked.slice(0, 2).map(
    (ability) => `${ABILITY_LABELS[ability.dimension]}：${Math.round(ability.score)} 分`,
  )
  const growthExperiments = ranked.slice(-2).map((ability) => {
    const label = ABILITY_LABELS[ability.dimension]
    return `未來兩週為「${label}」安排一次低風險實驗，事後記錄結果與下一次調整。`
  })

  const confidencePercent = Math.round(result.overallConfidence * 100)
  return {
    title: `你的 AI 時代行為傾向：${result.preferenceCode}`,
    summary: '這份結果描述你目前在工作情境中的偏好與可練習能力，不代表能力高低或固定命運。',
    preferenceNote: `四組人格偏好代碼為 ${result.preferenceCode}；它與六項 AIEQ 能力分開計算。`,
    strongestSignals,
    growthExperiments,
    confidenceNote: `本次結果信心程度約 ${confidencePercent}%。題數、跳題或跨情境不一致都會影響信心。`,
    disclaimer: result.disclaimer,
  }
}
