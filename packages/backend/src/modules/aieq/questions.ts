import type { AieqQuestion, QuestionOption, ScoreDimension } from './types.js'

function option(id: string, shortLabel: string, label: string, evidence: Partial<Record<ScoreDimension, number>>, aliases: string[] = []): QuestionOption {
  return { id, shortLabel, label, evidence, aliases }
}

/**
 * AI Personality 1.1. Questions 1-7 approved 2026-09-11; question 8 added 2026-09-18 as the second J/P item.
 * Button order never affects scoring.
 */
export const AIEQ_QUESTIONS: readonly AieqQuestion[] = [
  {
    id: 'q01_ai_trend', scenario: '暖身｜AI 趨勢', prompt: '對 AI 趨勢，你第一個反應是？',
    validation: 'direct', dimensions: ['energy'], options: [
      option('try', '我會想：「先玩玩看！」', '有新的 AI 工具，我通常會直接動手試試。', { energy: -0.5 }, ['期待', '想嘗試']),
      option('natural', '大家開始用，我就跟著用', '身邊有人帶著用，我通常很快就會一起試。', { energy: -0.125 }, ['順其自然']),
      option('observe', '我先不碰，確定有用再說', '我會等效果和風險都比較清楚，再決定要不要用。', { energy: 0.5 }, ['靜觀其變']),
    ],
  },
  {
    id: 'q02_ai_copy', scenario: '觀察｜AI 文案', prompt: '拿到一段 AI 文案，你最先想改什麼？',
    validation: 'direct', dimensions: ['input'], options: [
      option('angle', '我想換個更有趣的說法', '我會先想：還有沒有另一個切入角度？', { input: 3 }, ['換角度']),
      option('feeling', '我先把不順口的地方改掉', '哪一句讀起來卡卡的，我就先把它改得自然。', { input: -0.75 }, ['怪怪的']),
      option('logic', '我先檢查有沒有寫錯', '我會核對事實、錯字，以及前後有沒有矛盾。', { input: -3 }, ['改錯字', '改邏輯']),
    ],
  },
  {
    id: 'q03_ai_image', scenario: '觀察｜AI 圖像', prompt: '看到一張 AI 生成圖，你通常會？',
    validation: 'cross_check', dimensions: ['input'], options: [
      option('scroll', '我看一眼就滑過去了', '如果沒有特別打中我，我不會停留太久。', { input: -0.5 }, ['滑過去']),
      option('story', '我會想像畫面裡發生的故事', '我會好奇這是誰、在哪裡，以及接下來會怎樣。', { input: 2 }, ['想像故事']),
      option('flaw', '我會先找 AI 畫錯的地方', '手指、文字、光影有沒有問題，我一眼就會去看。', { input: -2 }, ['找破綻']),
    ],
  },
  {
    id: 'q04_ai_blocked', scenario: '反應｜AI 受阻', prompt: '當 AI 說做不到，你通常會？',
    validation: 'direct', dimensions: ['decide'], options: [
      option('disappointed', '我會有點失望：「怎麼不行？」', '期待落空時，我會先感受到那個挫折。', { decide: 3 }, ['失落']),
      option('retry', '我立刻換個問法，繼續試', '我會把問題拆小或換個指令，現在就把它做完。', { decide: -3 }, ['換個方式']),
      option('switch', '我先關掉 AI，改做別的', '我不想繼續卡住，這件事晚一點再處理。', { decide: -0.75 }, ['做別的']),
    ],
  },
  {
    id: 'q05_ai_slides', scenario: '判斷｜AI 簡報', prompt: '看到 AI 做的簡報，你最先說什麼？',
    validation: 'cross_check', dimensions: ['decide'], options: [
      option('usable', '我先想：「能直接用嗎？」', '只要方向對、能解決問題，我願意先用再調整。', { decide: -0.5 }, ['還不錯', '可以用']),
      option('warmth', '我先看它能不能打動人', '內容就算正確，我也在意觀眾看了有沒有感覺。', { decide: 2 }, ['少了溫度']),
      option('error', '我先看內容有沒有講錯', '數字、結論和前後邏輯正不正確，對我最重要。', { decide: -2 }, ['邏輯錯誤']),
    ],
  },
  {
    id: 'q06_ai_learning', scenario: '行動｜學習工具', prompt: '學習新的 AI 工具，你通常怎麼開始？',
    validation: 'cross_check', dimensions: ['energy'], options: [
      option('docs', '我喜歡自己摸索、慢慢試', '我會先看說明、動手測，自己搞懂最安心。', { energy: 2.5 }, ['讀文件', '自己試']),
      option('wait', '我先照著別人的教學做', '我會找現成步驟，自己跟著畫面一步一步操作。', { energy: -0.25 }, ['等別人']),
      option('discuss', '我直接找懂的人帶我操作', '有人可以當場回答，我會一邊問、一邊跟著試。', { energy: -2.5 }, ['問人', '討論']),
    ],
  },
  {
    id: 'q07_ai_habit', scenario: '習慣｜工作結構', prompt: '用 AI 協助工作時，你比較習慣？',
    validation: 'direct', dimensions: ['action'], options: [
      option('spontaneous', '我想到什麼就直接問', '每次情況不同，我喜歡現場發揮、邊問邊調整。', { action: 2 }, ['隨興發問']),
      option('forget', '我有存過範本，但常常沒用', '我知道範本放在哪裡，實際工作時卻常直接重問。', { action: -0.5 }, ['常忘']),
      option('template', '我每次都會打開固定範本', '常用工作我照著同一套步驟做，不會從頭再問。', { action: -2 }, ['固定模板']),
    ],
  },
  {
    // Second J/P item: closure vs keeping options open, a different facet from q07's working structure.
    // Strong weights are 3, not q07's 2: equal magnitudes tie at 0 and every tie is read as P (see aieqBalance.test.ts).
    id: 'q08_ai_options', scenario: '決定｜AI 選項', prompt: 'AI 一口氣給你三個都不錯的答案，你會？',
    validation: 'cross_check', dimensions: ['action'], options: [
      option('pick', '我挑一個，收工！', '選定就往下走，剩下的我不會再回頭看。', { action: -3 }, ['挑一個', '收工']),
      option('more', '我說：「再來三個！」', '說不定下一批更好，我想多看看再決定。', { action: 3 }, ['再來三個', '再來']),
      option('stash', '我選一個，另外兩個偷存起來', '先有個決定，但留著備案我比較安心。', { action: -0.75 }, ['偷存', '存起來', '備案']),
    ],
  },
]

/** Version stamped on every new session. Bump it whenever a question, option id, order or weight changes. */
export const INSTRUMENT_VERSION = 'ai-personality-1.1-8q'

/**
 * Every bank that ever stamped a session, keyed by version. A session is always scored with the bank it
 * was answered under, so changing the current bank never rewrites history. Never delete an entry that
 * has sessions in the database.
 */
export const QUESTION_BANKS: Readonly<Record<string, readonly AieqQuestion[]>> = {
  // 2026-09-11 to 2026-09-18: the same first seven items; q08 did not exist yet.
  'ai-personality-1.0-7q': AIEQ_QUESTIONS.slice(0, 7),
  [INSTRUMENT_VERSION]: AIEQ_QUESTIONS,
}

export function questionsFor(instrumentVersion: string): readonly AieqQuestion[] {
  const bank = QUESTION_BANKS[instrumentVersion]
  if (!bank) throw new Error(`unknown_instrument_version:${instrumentVersion}`)
  return bank
}

export function getQuestion(questionId: string): AieqQuestion | undefined {
  return AIEQ_QUESTIONS.find((question) => question.id === questionId)
}
