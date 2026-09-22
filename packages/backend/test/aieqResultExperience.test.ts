import { describe, expect, it } from 'vitest'
import { animalForCode } from '../src/modules/aieq/catalog.js'
import { AIEQ_QUESTIONS } from '../src/modules/aieq/questions.js'
import { buildResultExperience } from '../src/modules/aieq/resultExperience.js'
import { scoreAssessment } from '../src/modules/aieq/scoring.js'
import { createAieqSession, transitionAieqSession } from '../src/modules/aieq/stateMachine.js'

describe('AIEQ result experience', () => {
  it('translates the unchanged score into two signals and two real answer examples', () => {
    let session = createAieqSession('result-experience')
    AIEQ_QUESTIONS.forEach((question, index) => {
      session = transitionAieqSession(session, {
        eventId: `result-${index}`,
        sessionId: session.id,
        source: 'card',
        kind: 'answer',
        questionId: question.id,
        optionId: question.options[index % question.options.length].id,
        occurredAt: new Date(1_700_000_000_000 + index).toISOString(),
        interpretationConfidence: 1,
      }, AIEQ_QUESTIONS).session
    })

    const result = scoreAssessment(session, AIEQ_QUESTIONS)
    const snapshot = JSON.stringify(result)
    const experience = buildResultExperience(session, result, AIEQ_QUESTIONS, animalForCode(result.typeKey))

    expect(experience.whyThisType).toMatch(/型的你/)
    expect(experience.strongestSignals).toHaveLength(2)
    expect(experience.answerEvidence).toHaveLength(2)
    expect(experience.answerEvidence.every((item) => item.question && item.answer && item.explanation)).toBe(true)
    expect(experience.radarSummary).toMatch(/最明顯|最有彈性/)
    expect(JSON.stringify(result)).toBe(snapshot)
  })
})
