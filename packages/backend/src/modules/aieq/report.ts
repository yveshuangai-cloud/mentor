import type { AssessmentResult, MbtiDimension } from './types.js'

const AXIS_LABELS: Record<MbtiDimension, string> = { EI: 'E / I', SN: 'S / N', TF: 'T / F', JP: 'J / P' }

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
  const ranked = Object.values(result.mbtiPreferences).sort((a, b) => b.strength - a.strength)
  const strongestSignals = ranked.slice(0, 2).map(
    (axis) => `${AXIS_LABELS[axis.dimension]}：${axis.preference}，清晰度 ${Math.round(axis.strength)}%`,
  )
  const growthExperiments = ranked.slice(-2).map((axis) => {
    const label = AXIS_LABELS[axis.dimension]
    return `${label} 接近邊界時，保留「目前傾向」的說法，並從日常行為繼續觀察。`
  })

  const confidencePercent = Math.round(result.overallConfidence * 100)
  return {
    title: `你的 AI 人格誌：${result.preferenceCode}`,
    summary: '這份結果描述你目前使用 AI 的偏好，不代表能力高低或固定命運。',
    preferenceNote: `四組人格偏好代碼為 ${result.preferenceCode}；各軸需分開閱讀清晰度。`,
    strongestSignals,
    growthExperiments,
    confidenceNote: `本次結果信心程度約 ${confidencePercent}%。題數、跳題或跨情境不一致都會影響信心。`,
    disclaimer: result.disclaimer,
  }
}
