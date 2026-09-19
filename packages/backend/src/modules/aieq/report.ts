import { animalForCode } from './catalog.js'
import type { AssessmentResult } from './types.js'

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
  const animal = animalForCode(result.typeKey)
  const ranked = Object.values(result.axes).sort((a, b) => b.strength - a.strength)
  const strongestSignals = ranked.slice(0, 2).map(
    (axis) => `${axis.axisName}：偏${axis.poleName}，清晰度 ${Math.round(axis.strength)}%`,
  )
  const growthExperiments = ranked.slice(-2).map(
    (axis) => `${axis.axisName} 兩邊都很接近時，就當成「目前的傾向」，再從日常行為慢慢觀察。`,
  )

  const confidencePercent = Math.round(result.overallConfidence * 100)
  return {
    title: `你的 AI 人格誌：${animal.name}・${animal.title}`,
    summary: '這份結果描述你目前使用 AI 的偏好，不代表能力高低或固定命運。',
    preferenceNote: `四種選擇傾向要分開讀，每一條的清晰度不一樣。`,
    strongestSignals,
    growthExperiments,
    confidenceNote: `本次結果信心程度約 ${confidencePercent}%。題數、跳題或跨情境不一致都會影響信心。`,
    disclaimer: result.disclaimer,
  }
}
