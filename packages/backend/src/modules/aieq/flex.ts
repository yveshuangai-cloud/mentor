import type { AieqQuestion } from './types.js'
import type { AssessmentResult } from './types.js'
import { animalForCode } from './catalog.js'

export function buildThreeChoiceFlex(sessionId: string, question: AieqQuestion): Record<string, unknown> {
  return {
    type: 'bubble',
    size: 'mega',
    header: {
      type: 'box',
      layout: 'vertical',
      backgroundColor: '#505158',
      paddingAll: '20px',
      contents: [
        { type: 'text', text: 'AIEQ 情境題', color: '#F1A4BA', size: 'sm', weight: 'bold' },
        { type: 'text', text: question.scenario, color: '#FFFFFF', size: 'lg', weight: 'bold', wrap: true },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      spacing: 'md',
      paddingAll: '20px',
      contents: [
        { type: 'text', text: question.prompt, size: 'md', weight: 'bold', wrap: true },
        ...question.options.map((option) => ({
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'postback',
            label: option.shortLabel,
            displayText: option.shortLabel,
            data: new URLSearchParams({
              action: 'aieq_answer',
              session_id: sessionId,
              question_id: question.id,
              option_id: option.id,
            }).toString(),
          },
        })),
        {
          type: 'box',
          layout: 'horizontal',
          spacing: 'sm',
          contents: [
            {
              type: 'button',
              height: 'sm',
              action: {
                type: 'postback',
                label: '不確定／跳過',
                data: new URLSearchParams({
                  action: 'aieq_uncertain',
                  session_id: sessionId,
                  question_id: question.id,
                }).toString(),
              },
            },
            {
              type: 'button',
              height: 'sm',
              action: {
                type: 'postback',
                label: '回上一題',
                data: new URLSearchParams({ action: 'aieq_back', session_id: sessionId }).toString(),
              },
            },
          ],
        },
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '請選最接近你平常行為的答案；沒有標準答案。',
          size: 'xs',
          color: '#777777',
          wrap: true,
        },
      ],
    },
  }
}

export function buildResultFlex(
  result: AssessmentResult,
  publicBaseUrl: string,
  resultPageUrl = `${publicBaseUrl}/aieq`,
): Record<string, unknown> {
  const animal = animalForCode(result.preferenceCode)
  return {
    type: 'bubble',
    size: 'mega',
    hero: {
      type: 'image',
      url: `${publicBaseUrl}${animal.imagePath}`,
      size: 'full',
      aspectRatio: '1:1',
      aspectMode: 'cover',
      action: { type: 'uri', label: '查看完整結果', uri: resultPageUrl },
    },
    body: {
      type: 'box', layout: 'vertical', spacing: 'md', paddingAll: '20px',
      contents: [
        { type: 'text', text: result.preferenceCode, size: 'xxl', weight: 'bold', color: '#505158' },
        { type: 'text', text: `${animal.name}型`, size: 'lg', weight: 'bold', color: '#D95F82' },
        { type: 'text', text: animal.strength, wrap: true, color: '#505158' },
        { type: 'text', text: `結果信心程度 ${Math.round(result.overallConfidence * 100)}%`, size: 'sm', color: '#777780' },
        { type: 'button', style: 'primary', color: '#D95F82', action: { type: 'uri', label: '確認結果與看朋友圈', uri: resultPageUrl } },
      ],
    },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '非心理診斷，也不是官方 MBTI® 測驗。', size: 'xs', color: '#777780', wrap: true },
    ] },
  }
}
