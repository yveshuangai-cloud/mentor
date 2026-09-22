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
      ],
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: '請直覺回答，不用考慮太多。選最接近平常行為的一項。',
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
  const animal = animalForCode(result.typeKey)
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
        { type: 'text', text: animal.name, size: 'xxl', weight: 'bold', color: '#505158' },
        { type: 'text', text: animal.title, size: 'lg', weight: 'bold', color: '#D95F82' },
        { type: 'text', text: animal.displayCode, size: 'sm', color: '#9B9B9B' },
        { type: 'text', text: animal.strength, wrap: true, color: '#505158' },
        { type: 'text', text: `結果信心程度 ${Math.round(result.overallConfidence * 100)}%`, size: 'sm', color: '#777780' },
        { type: 'button', style: 'primary', color: '#D95F82', action: { type: 'uri', label: '確認結果與看朋友圈', uri: resultPageUrl } },
      ],
    },
    footer: { type: 'box', layout: 'vertical', contents: [
      { type: 'text', text: '描述目前傾向，非心理診斷，也不評量能力高低。', size: 'xs', color: '#777780', wrap: true },
    ] },
  }
}

/**
 * The card a player sends to friends from the result page (LIFF shareTargetPicker).
 *
 * Every share card image (941x1672) has a placeholder portrait baked into the same ellipse:
 * left 627, top 38, 292x308. LINE chat cannot overlay HTML, so the player's avatar is an
 * absolutely positioned circle on that spot. A "mega" bubble is 300px wide, so the card is
 * 533px tall and the covering circle (316px on the card) is 101px at left 196, top 11.
 * Without a usable avatar the spot is still covered, with the player's initial, so a
 * stranger's illustrated face never goes out under the player's name.
 */
export function buildShareInviteFlex(input: {
  typeCode: string
  displayName?: string | null
  pictureUrl?: string | null
  inviteUrl: string
  publicBaseUrl: string
}): { type: 'flex'; altText: string; contents: Record<string, unknown> } {
  const animal = animalForCode(input.typeCode)
  const name = [...(input.displayName ?? '').trim()].slice(0, 14).join('') || '我'
  const avatar = input.pictureUrl?.startsWith('https://') ? input.pictureUrl : null
  const circle = {
    type: 'box', layout: 'vertical', position: 'absolute',
    offsetTop: '11px', offsetStart: '196px', width: '101px', height: '101px',
    cornerRadius: '51px', borderWidth: '2px', borderColor: '#F5F4F0', backgroundColor: '#050505',
    justifyContent: 'center', alignItems: 'center',
    contents: [avatar
      ? { type: 'image', url: avatar, size: 'full', aspectRatio: '1:1', aspectMode: 'cover' }
      : { type: 'text', text: [...name][0], size: '3xl', weight: 'bold', color: '#41FF78', align: 'center' }],
  }
  return {
    type: 'flex',
    altText: `${name} 的 AI 人格是${animal.name}・${animal.title}，你也來測測看`,
    contents: {
      type: 'bubble',
      size: 'mega',
      styles: { body: { backgroundColor: '#050505' }, footer: { backgroundColor: '#050505' } },
      body: {
        type: 'box', layout: 'vertical', paddingAll: '0px',
        action: { type: 'uri', label: '開啟 AI 人格誌', uri: input.inviteUrl },
        contents: [
          { type: 'image', url: `${input.publicBaseUrl}${animal.shareCardPath}`, size: 'full', aspectRatio: '941:1672', aspectMode: 'cover' },
          circle,
          {
            type: 'box', layout: 'vertical', position: 'absolute', offsetTop: '52px', offsetStart: '16px', width: '170px',
            contents: [
              { type: 'text', text: name, size: 'sm', weight: 'bold', color: '#41FF78' },
              { type: 'text', text: '的 AI 人格', size: 'xxs', color: '#CFCFCF' },
            ],
          },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: '14px',
        contents: [
          { type: 'button', style: 'primary', color: '#FF1785', height: 'sm', action: { type: 'uri', label: '我也來測我的 AI 人格', uri: input.inviteUrl } },
          { type: 'text', text: '8 個情境・約 1 分鐘｜描述目前傾向，非心理診斷', size: 'xxs', color: '#9B9B9B', wrap: true, align: 'center' },
        ],
      },
    },
  }
}
