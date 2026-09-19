import type { AieqQuestion, QuestionOption, ScoreDimension } from './types.js'

function option(id: string, shortLabel: string, label: string, evidence: Partial<Record<ScoreDimension, number>>, aliases: string[] = []): QuestionOption {
  return { id, shortLabel, label, evidence, aliases }
}

/**
 * AI Personality 1.1. Questions 1-7 approved 2026-09-11; question 8 added 2026-09-18 as the second J/P item.
 * Button order never affects scoring.
 */
const BANK_1_1: readonly AieqQuestion[] = [
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


/**
 * AI Personality 2.0, the workplace bank. Copy is YVES's 大白話 rewrite (V3/V4, 2026-09-15 and 09-19);
 * every weight comes from docs/aieq/AIEQ-CLASSIFICATION-LOGIC-AND-QUESTION-BANK.md, which carries the
 * original signals for all four axes and all six abilities.
 *
 * One correction from YVES on 2026-09-19: two questions on the same axis must not carry matching
 * magnitudes, because ±1 against ∓1 cancels to exactly zero and the tie is then read as the right-hand
 * pole. That happened on q07/q03 and on q08/q04, so q07 and q08 were eased off 1.00. Simulated over all
 * 6,561 answer sheets: no cancellation, every pole between 44% and 56%, all 16 types reachable
 * (3.9%-9.5%), lowest pole reliability 75%.
 */
const BANK_2_0: readonly AieqQuestion[] = [
  {
    id: 'q01_new_tool', scenario: '新工具降臨', prompt: '公司要導入你沒碰過的 AI 神器，你最先做什麼？',
    validation: 'direct', dimensions: ['input'], options: [
      option('experiment', '廢話不多說，先動手玩！', '拿一個不痛不癢的小任務直接開測，好不好用試了就知道。',
        { input: 0.70, transition_speed: 1.00, ambiguity_tolerance: 0.70, agency: 0.80 }, ['先玩', '直接試']),
      option('manual', '先冷靜，看熟說明書。', '把操作手冊和教學影片看完，確認每個步驟怎麼走再說。',
        { input: -0.80, transition_speed: -0.25, ambiguity_tolerance: -0.50, continuous_learning: 0.50 }, ['看說明']),
      option('goal', '先問清楚老闆到底要幹嘛。', '找主管或前輩問清楚：我們導入這個到底想解決什麼問題？',
        { input: -0.20, ai_collaboration: 0.60, verification: 0.60, agency: 0.35 }, ['問目標']),
    ],
  },
  {
    id: 'q02_ai_output', scenario: '高風險產出', prompt: 'AI 生出一份超完美、卻會影響重要客戶的報告，你怎麼處理？',
    validation: 'reverse', dimensions: ['decide'], options: [
      option('verify', '絕對不能盲信，查核到底！', '把關鍵數據抽出來，回到原始資料庫一筆一筆核對。',
        { decide: -0.80, verification: 1.00, agency: 0.55 }, ['查證', '核對']),
      option('review', '數據是死的，人是活的。', '找最懂這個客戶的同事一起看，確認對方看了會不會不舒服。',
        { decide: 0.70, verification: 0.75, ai_collaboration: 0.80 }, ['找人看']),
      option('submit', '看起來有模有樣，先交再說。', '格式滿完整的，先交出去，主管或客戶有意見再改。',
        { decide: -0.10, verification: -1.00, agency: -0.35 }, ['先交']),
    ],
  },
  {
    id: 'q03_team_trial', scenario: '團隊大卡關', prompt: '團隊卡關很久，你想用 AI 解解看，你會扮演哪種角色？',
    validation: 'direct', dimensions: ['energy'], options: [
      option('gather', '揪大家一起來動腦！', '把人拉個群或開個小會，一起畫流程，當場分工動手試。',
        { energy: -1.00, ai_collaboration: 1.00, agency: 0.80 }, ['召集', '開會']),
      option('prototype', '自己先默默閉關生個大招。', '自己安靜研究，做出一個真的能跑的原型，再拿出來給大家看。',
        { energy: 1.00, ai_collaboration: 0.25, agency: 0.90 }, ['自己做', '原型']),
      option('clarify', '先幫大家把痛點釐清。', '把大家卡住的地方和擔憂整理成一份共同的問題清單，再來想辦法。',
        { energy: -0.35, ai_collaboration: 0.85, verification: 0.40 }, ['釐清']),
    ],
  },
  {
    id: 'q04_plan_breaks', scenario: '期限大危機', prompt: '離期限剩兩天，AI 流程突然大當機，你第一個反應是？',
    validation: 'reverse', dimensions: ['action'], options: [
      option('replan', '立刻重排時程，穩住底線。', '重新盤點剩下的時間和人力，重排責任與檢查點，保住最基本的交付。',
        { action: -1.00, transition_speed: 0.65, ambiguity_tolerance: -0.25, agency: 0.70 }, ['重排', '重新規劃']),
      option('alternatives', '狡兔有三窟，爆試替代方案！', '同時開好幾條替代路線一起試，哪條能通就走哪條。',
        { action: 1.00, transition_speed: 1.00, ambiguity_tolerance: 0.90 }, ['試別的', '替代']),
      option('hold', '先深呼吸，等系統修好。', '暫停一下，等工具恢復正常，或打聽有沒有更明確的情報再說。',
        { action: -0.15, transition_speed: -0.90, ambiguity_tolerance: -0.80, agency: -0.70 }, ['等一下']),
    ],
  },
  {
    id: 'q05_failed_automation', scenario: '排錯找毛病', prompt: 'AI 自動化連兩次失敗，還看不出哪裡有問題，下一步？',
    validation: 'cross_check', dimensions: ['input'], options: [
      option('debug', '捲起袖子，一步步抓蟲。', '把流程切成很細的步驟，逐一檢查輸入和輸出，揪出卡關點。',
        { input: -1.00, verification: 1.00, continuous_learning: 0.70 }, ['抓蟲', '逐步檢查']),
      option('rethink', '這路走不通，換個腦袋想！', '退一步重想，覺得可能是架構有問題，乾脆換一種解法。',
        { input: 1.00, transition_speed: 0.60, ambiguity_tolerance: 0.60, continuous_learning: 0.55 }, ['換架構']),
      option('revert', '算了別弄了，改回全人工。', '先切回原本的手動方式，暫時不想再投入時間。',
        { input: -0.35, transition_speed: -0.55, continuous_learning: -0.80 }, ['改人工']),
    ],
  },
  {
    id: 'q06_team_disagrees', scenario: '神仙打架時', prompt: '團隊為了要不要照 AI 建議做吵成兩派，你會怎麼推進？',
    validation: 'cross_check', dimensions: ['decide'], options: [
      option('feelings', '先處理心情，再處理事情。', '讓雙方把在擔心什麼說清楚，找出大家心理上都能接受的做法。',
        { decide: 1.00, ai_collaboration: 1.00, verification: 0.30 }, ['先談人']),
      option('standard', '吵這個沒意義，用數據說話。', '訂出客觀的測試標準和風險門檻，用小規模實測決勝負。',
        { decide: -1.00, ai_collaboration: 0.65, verification: 1.00 }, ['用數據', '測試']),
      option('escalate', '整理好兩邊說法，讓老闆選。', '把兩派意見打包往上呈報，讓有決定權的人來決定。',
        { decide: -0.25, ai_collaboration: -0.30, agency: -0.35 }, ['給老闆']),
    ],
  },
  {
    id: 'q07_learning', scenario: '自學新技能', prompt: '新的 AI 模型問世，網路上只有零碎討論，你怎麼開始？',
    validation: 'reverse', dimensions: ['energy'], options: [
      option('squad', '找戰友組隊，互相交流踩坑！', '找幾個同事分頭去測，再交換心得與發現。',
        { energy: -0.80, continuous_learning: 0.90, ai_collaboration: 1.00, agency: 0.55 }, ['組隊', '找同伴']),
      option('notes', '狂收資料，做自己的神筆記。', '自己動手實測，整理成可重複使用的筆記。',
        { energy: 0.85, continuous_learning: 1.00, agency: 0.80 }, ['做筆記']),
      option('course', '讓子彈飛，等官方出教學。', '等官方推出完整課程，或公司辦訓練再學。',
        { energy: 0.10, continuous_learning: -0.80, agency: -0.75 }, ['等課程']),
    ],
  },
  {
    id: 'q08_vague_request', scenario: '通靈大考驗', prompt: '老闆只說「用 AI 讓這件事更有效率」，你怎麼接？',
    validation: 'direct', dimensions: ['action'], options: [
      option('scope', '確認過眼神，先定義範圍。', '列出目標、限制與驗收標準，確認後才開始。',
        { action: -0.85, ambiguity_tolerance: -0.25, agency: 0.65, verification: 0.50 }, ['先定義']),
      option('draft', '管他的，憑感覺先捏個初版！', '照現有線索先做個雛型，拿去問老闆是不是要這個。',
        { action: 0.80, ambiguity_tolerance: 1.00, agency: 1.00, transition_speed: 0.75 }, ['先做做看']),
      option('defer', '這太抽象了吧！先去忙別的。', '先處理其他確定的工作，等更清楚的指示再說。',
        { action: -0.25, ambiguity_tolerance: -0.85, agency: -1.00 }, ['先擱著']),
    ],
  },
]

export const AIEQ_QUESTIONS: readonly AieqQuestion[] = BANK_2_0

/** Version stamped on every new session. Bump it whenever a question, option id, order or weight changes. */
export const INSTRUMENT_VERSION = 'ai-personality-2.0-8q'

/**
 * Every bank that ever stamped a session, keyed by version. A session is always scored with the bank it
 * was answered under, so changing the current bank never rewrites history. Never delete an entry that
 * has sessions in the database.
 */
export const QUESTION_BANKS: Readonly<Record<string, readonly AieqQuestion[]>> = {
  // 2026-09-11 to 2026-09-18: the same first seven items; q08 did not exist yet.
  'ai-personality-1.0-7q': BANK_1_1.slice(0, 7),
  // 2026-09-18 to 2026-09-19: the everyday bank, eight items.
  'ai-personality-1.1-8q': BANK_1_1,
  [INSTRUMENT_VERSION]: BANK_2_0,
}

export function questionsFor(instrumentVersion: string): readonly AieqQuestion[] {
  const bank = QUESTION_BANKS[instrumentVersion]
  if (!bank) throw new Error(`unknown_instrument_version:${instrumentVersion}`)
  return bank
}

export function getQuestion(questionId: string): AieqQuestion | undefined {
  return AIEQ_QUESTIONS.find((question) => question.id === questionId)
}
