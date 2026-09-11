import type { AieqQuestion, QuestionOption, ScoreDimension } from './types.js'

function option(id: string, shortLabel: string, evidence: Partial<Record<ScoreDimension, number>>, aliases: string[] = []): QuestionOption {
  return { id, shortLabel, label: shortLabel, evidence, aliases }
}

/** AI Personality 1.0, approved 2026-09-11. Button order never affects scoring. */
export const AIEQ_QUESTIONS: readonly AieqQuestion[] = [
  {
    id: 'q01_ai_trend', scenario: '暖身｜AI 趨勢', prompt: '對 AI 趨勢，你第一個反應是？',
    validation: 'direct', dimensions: ['EI'], options: [
      option('try', '很期待去嘗試', { EI: -0.5 }, ['期待', '想嘗試']),
      option('natural', '順其自然發展', { EI: -0.125 }, ['順其自然']),
      option('observe', '靜觀其變就好', { EI: 0.5 }, ['靜觀其變']),
    ],
  },
  {
    id: 'q02_ai_copy', scenario: '觀察｜AI 文案', prompt: '拿到一段 AI 文案，你最先想改什麼？',
    validation: 'direct', dimensions: ['SN'], options: [
      option('angle', '換個角度說法', { SN: 3 }, ['換角度']),
      option('feeling', '感覺怪怪而已', { SN: -0.75 }, ['怪怪的']),
      option('logic', '抓錯字改邏輯', { SN: -3 }, ['改錯字', '改邏輯']),
    ],
  },
  {
    id: 'q03_ai_image', scenario: '觀察｜AI 圖像', prompt: '看到一張 AI 生成圖，你通常會？',
    validation: 'cross_check', dimensions: ['SN'], options: [
      option('scroll', '看完就滑過去', { SN: -0.5 }, ['滑過去']),
      option('story', '想像背後故事', { SN: 2 }, ['想像故事']),
      option('flaw', '找出圖裡破綻', { SN: -2 }, ['找破綻']),
    ],
  },
  {
    id: 'q04_ai_blocked', scenario: '反應｜AI 受阻', prompt: '當 AI 說做不到，你通常會？',
    validation: 'direct', dimensions: ['TF'], options: [
      option('disappointed', '覺得有點失落', { TF: 3 }, ['失落']),
      option('retry', '換個方式再試', { TF: -3 }, ['換個方式']),
      option('switch', '先去做別的事', { TF: -0.75 }, ['做別的']),
    ],
  },
  {
    id: 'q05_ai_slides', scenario: '判斷｜AI 簡報', prompt: '看到 AI 做的簡報，你最先說什麼？',
    validation: 'cross_check', dimensions: ['TF'], options: [
      option('usable', '說還不錯可用', { TF: -0.5 }, ['還不錯', '可以用']),
      option('warmth', '說少了點溫度', { TF: 2 }, ['少了溫度']),
      option('error', '指出邏輯錯誤', { TF: -2 }, ['邏輯錯誤']),
    ],
  },
  {
    id: 'q06_ai_learning', scenario: '行動｜學習工具', prompt: '學習新的 AI 工具，你通常怎麼開始？',
    validation: 'cross_check', dimensions: ['EI'], options: [
      option('docs', '自己讀文件試', { EI: 2.5 }, ['讀文件', '自己試']),
      option('wait', '等別人先用過', { EI: -0.25 }, ['等別人']),
      option('discuss', '上網問人討論', { EI: -2.5 }, ['問人', '討論']),
    ],
  },
  {
    id: 'q07_ai_habit', scenario: '習慣｜工作結構', prompt: '用 AI 協助工作時，你比較習慣？',
    validation: 'direct', dimensions: ['JP'], options: [
      option('spontaneous', '當下隨興發問', { JP: 2 }, ['隨興發問']),
      option('forget', '想固定卻常忘', { JP: -0.5 }, ['常忘']),
      option('template', '固定模板照跑', { JP: -2 }, ['固定模板']),
    ],
  },
]

export function getQuestion(questionId: string): AieqQuestion | undefined {
  return AIEQ_QUESTIONS.find((question) => question.id === questionId)
}
