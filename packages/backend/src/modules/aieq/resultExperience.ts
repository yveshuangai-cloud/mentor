import type { AieqAnimal } from './catalog.js'
import type { AieqQuestion, AieqSession, AssessmentResult, AxisId, AxisResult } from './types.js'

export interface ResultExperience {
  whyThisType: string
  strongestSignals: Array<{
    axisName: string
    poleName: string
    clarityLabel: string
    description: string
  }>
  radarSummary: string
  answerEvidence: Array<{
    question: string
    answer: string
    explanation: string
  }>
}

function clarityLabel(axis: AxisResult): string {
  if (axis.strength >= 67) return '這個傾向很明顯'
  if (axis.strength >= 34) return '這個傾向比較明顯'
  return '兩種做法都會，會看情況調整'
}

function rankedAxes(result: AssessmentResult): AxisResult[] {
  return (Object.values(result.axes) as AxisResult[]).sort((a, b) => b.strength - a.strength)
}

function evidenceForAxis(axis: AxisResult, session: AieqSession, questions: readonly AieqQuestion[]) {
  const candidates = questions.flatMap((question) => {
    const answer = session.answers[question.id]
    const selected = answer?.optionId ? question.options.find((option) => option.id === answer.optionId) : undefined
    const value = selected?.evidence[axis.dimension]
    if (!selected || value === undefined || value === 0) return []
    const aligned = axis.balance === 0 || Math.sign(value) === Math.sign(axis.balance)
    return [{ question, selected, value, aligned }]
  }).sort((a, b) => Number(b.aligned) - Number(a.aligned) || Math.abs(b.value) - Math.abs(a.value))

  const best = candidates[0]
  if (!best) return null
  return {
    question: best.question.prompt,
    answer: best.selected.shortLabel,
    explanation: `這個選擇顯示，你在「${axis.axisName}」上比較常採用「${axis.poleName}」的做法。`,
  }
}

/**
 * Translates an unchanged assessment into a first-time-player explanation.
 * This is presentation-only: it never changes the question bank, weights, type or stored result.
 */
export function buildResultExperience(
  session: AieqSession,
  result: AssessmentResult,
  questions: readonly AieqQuestion[],
  animal: AieqAnimal,
): ResultExperience {
  const ranked = rankedAxes(result)
  const strongest = ranked.slice(0, 2)
  const mostFlexible = ranked[ranked.length - 1]
  const flexibleReading = mostFlexible.strength < 34
    ? '兩種做法都可能依情況使用'
    : `仍偏向${mostFlexible.poleName}，只是相較其他面向沒有那麼強烈`
  const evidence = strongest
    .map((axis) => evidenceForAxis(axis, session, questions))
    .filter((item): item is NonNullable<typeof item> => Boolean(item))

  return {
    whyThisType: `${animal.name}型的你，這次最明顯的是「${strongest[0].poleName}」，同時也常用「${strongest[1].poleName}」的方式處理事情。`,
    strongestSignals: strongest.map((axis) => ({
      axisName: axis.axisName,
      poleName: axis.poleName,
      clarityLabel: clarityLabel(axis),
      description: axis.poleBlurb,
    })),
    radarSummary: `你最明顯的是「${strongest[0].axisName}」：偏向${strongest[0].poleName}；相對最有彈性的是「${mostFlexible.axisName}」，${flexibleReading}。`,
    answerEvidence: evidence,
  }
}
