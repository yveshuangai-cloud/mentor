import type { AieqQuestion, QuestionOption, ScoreDimension } from './types.js'

function option(
  id: string,
  shortLabel: string,
  label: string,
  evidence: Partial<Record<ScoreDimension, number>>,
  aliases: string[] = [],
): QuestionOption {
  return { id, shortLabel, label, evidence, aliases }
}

/**
 * Pilot bank: behavioral scenarios only. Ordering deliberately varies so the
 * first option is not consistently associated with either pole or a high score.
 */
export const AIEQ_QUESTIONS: readonly AieqQuestion[] = [
  {
    id: 'q01_new_tool',
    scenario: '公司下週要導入一套你沒用過的 AI 工具。',
    prompt: '你最可能先做什麼？',
    validation: 'direct',
    dimensions: ['SN', 'transition_speed', 'ambiguity_tolerance', 'agency', 'continuous_learning'],
    options: [
      option('a', '先做小實驗', '直接拿一個低風險工作做小實驗，再依結果調整', {
        SN: 0.7,
        transition_speed: 1,
        ambiguity_tolerance: 0.7,
        agency: 0.8,
      }, ['小實驗', '先試試看']),
      option('b', '先看操作資料', '先讀完操作說明與案例，確認流程後再開始', {
        SN: -0.8,
        transition_speed: -0.25,
        ambiguity_tolerance: -0.5,
        continuous_learning: 0.5,
      }, ['先看說明', '讀資料']),
      option('c', '先問清楚目標', '先找主管或同事確認導入目標與成功標準', {
        SN: -0.2,
        ai_collaboration: 0.6,
        verification: 0.6,
        agency: 0.35,
      }, ['先問目標', '問主管']),
    ],
  },
  {
    id: 'q02_ai_output',
    scenario: 'AI 很快產出一份看起來完整、但會影響客戶的重要分析。',
    prompt: '你會怎麼處理？',
    validation: 'reverse',
    dimensions: ['TF', 'verification', 'agency', 'ai_collaboration'],
    options: [
      option('a', '先交再說', '格式完整就先交付，有問題再修正', {
        TF: -0.1,
        verification: -1,
        agency: -0.35,
      }, ['先交付', '有問題再改']),
      option('b', '逐項查證', '抽出關鍵結論，回到資料來源逐項查證', {
        TF: -0.8,
        verification: 1,
        agency: 0.55,
      }, ['查證來源', '逐項驗證']),
      option('c', '找人共同檢視', '請熟悉客戶情境的人一起檢視結論與風險', {
        TF: 0.7,
        verification: 0.75,
        ai_collaboration: 0.8,
      }, ['一起檢查', '找人檢視']),
    ],
  },
  {
    id: 'q03_team_trial',
    scenario: '團隊想試用 AI 改善一個長期卡住的流程。',
    prompt: '你通常會扮演哪種角色？',
    validation: 'direct',
    dimensions: ['EI', 'ai_collaboration', 'agency'],
    options: [
      option('a', '召集大家試做', '召集相關的人一起畫流程、分工試做', {
        EI: -1,
        ai_collaboration: 1,
        agency: 0.8,
      }, ['召集大家', '一起試做']),
      option('b', '獨立做出原型', '先自己安靜研究並做出原型，再拿給團隊看', {
        EI: 1,
        ai_collaboration: 0.25,
        agency: 0.9,
      }, ['自己做原型', '獨立研究']),
      option('c', '整理需求風險', '先整理每個人的需求與顧慮，形成共同問題', {
        EI: -0.35,
        ai_collaboration: 0.85,
        verification: 0.4,
      }, ['整理需求', '整理風險']),
    ],
  },
  {
    id: 'q04_plan_breaks',
    scenario: '期限剩兩天，原本規劃的 AI 工作流程突然不能用了。',
    prompt: '你的第一個反應通常是？',
    validation: 'reverse',
    dimensions: ['JP', 'transition_speed', 'ambiguity_tolerance', 'agency'],
    options: [
      option('a', '重排行程與責任', '立刻重排工作、責任與檢查點，保住必要交付', {
        JP: -1,
        transition_speed: 0.65,
        ambiguity_tolerance: -0.25,
        agency: 0.7,
      }, ['重新排程', '重排工作']),
      option('b', '試幾條替代路線', '快速試幾條替代路線，邊做邊決定採用哪條', {
        JP: 1,
        transition_speed: 1,
        ambiguity_tolerance: 0.9,
      }, ['替代路線', '邊做邊調']),
      option('c', '先停下來等資訊', '先暫停，等工具恢復或有更完整資訊再決定', {
        JP: -0.15,
        transition_speed: -0.9,
        ambiguity_tolerance: -0.8,
        agency: -0.7,
      }, ['先暫停', '等資訊']),
    ],
  },
  {
    id: 'q05_failed_automation',
    scenario: '你做的自動化連續兩次失敗，而且原因不明。',
    prompt: '下一步你比較可能怎麼做？',
    validation: 'cross_check',
    dimensions: ['SN', 'verification', 'continuous_learning', 'transition_speed', 'ambiguity_tolerance'],
    options: [
      option('a', '拆解實際步驟', '把流程拆小，逐步記錄輸入、輸出與錯誤', {
        SN: -1,
        verification: 1,
        continuous_learning: 0.7,
      }, ['拆解流程', '逐步記錄']),
      option('b', '換個架構重想', '退一步重想問題，也許應該換一種自動化架構', {
        SN: 1,
        transition_speed: 0.6,
        ambiguity_tolerance: 0.6,
        continuous_learning: 0.55,
      }, ['換個架構', '重新想問題']),
      option('c', '先改回人工', '先改回原本的人工方式，暫時不再投入', {
        SN: -0.35,
        transition_speed: -0.55,
        continuous_learning: -0.8,
      }, ['改回人工', '先不用了']),
    ],
  },
  {
    id: 'q06_team_disagrees',
    scenario: '團隊對「是否採用 AI 的建議」意見分成兩派。',
    prompt: '你最可能如何推進？',
    validation: 'cross_check',
    dimensions: ['TF', 'ai_collaboration', 'verification', 'agency'],
    options: [
      option('a', '先談人的顧慮', '先讓雙方說出擔心的影響，再找能共同接受的做法', {
        TF: 1,
        ai_collaboration: 1,
        verification: 0.3,
      }, ['談顧慮', '共同接受']),
      option('b', '設共同測試標準', '先定義資料、指標與風險門檻，用小測試做決定', {
        TF: -1,
        ai_collaboration: 0.65,
        verification: 1,
      }, ['測試標準', '用數據決定']),
      option('c', '交給權責者決定', '整理兩派意見，交由最終權責者直接決定', {
        TF: -0.25,
        ai_collaboration: -0.3,
        agency: -0.35,
      }, ['主管決定', '權責者決定']),
    ],
  },
  {
    id: 'q07_learning',
    scenario: '出現一個可能改變你工作的全新 AI 模型，但教學資料很零散。',
    prompt: '你會如何開始理解它？',
    validation: 'reverse',
    dimensions: ['EI', 'continuous_learning', 'agency'],
    options: [
      option('a', '等完整課程', '等有完整課程或公司安排訓練後再學', {
        EI: 0.1,
        continuous_learning: -0.8,
        agency: -0.75,
      }, ['等課程', '等公司訓練']),
      option('b', '找同伴交換測試', '找幾個同伴各自測試，再交換發現與踩坑', {
        EI: -1,
        continuous_learning: 0.9,
        ai_collaboration: 1,
        agency: 0.55,
      }, ['找同伴', '交換測試']),
      option('c', '自己建立筆記', '自己蒐集碎片資料、實作並整理成可重用筆記', {
        EI: 1,
        continuous_learning: 1,
        agency: 0.8,
      }, ['自己研究', '建立筆記']),
    ],
  },
  {
    id: 'q08_vague_request',
    scenario: '主管只說「用 AI 讓這件事更有效率」，沒有給明確標準。',
    prompt: '你通常怎麼接這個任務？',
    validation: 'direct',
    dimensions: ['JP', 'ambiguity_tolerance', 'agency', 'verification', 'transition_speed'],
    options: [
      option('a', '先定義範圍', '列出目標、限制與驗收方式，確認後再執行', {
        JP: -1,
        ambiguity_tolerance: -0.25,
        agency: 0.65,
        verification: 0.5,
      }, ['定義範圍', '先確認標準']),
      option('b', '先做可看的版本', '根據現有線索先做一個可看的版本，用回饋縮小方向', {
        JP: 1,
        ambiguity_tolerance: 1,
        agency: 1,
        transition_speed: 0.75,
      }, ['先做版本', '用回饋調整']),
      option('c', '等待更明確指示', '先處理其他工作，等收到更明確指示', {
        JP: -0.25,
        ambiguity_tolerance: -0.85,
        agency: -1,
      }, ['等待指示', '先做別的']),
    ],
  },
  {
    id: 'q09_people_impact',
    scenario: 'AI 建議的方案能省很多成本，但可能讓一群同事的工作大幅改變。',
    prompt: '在支持方案前，你最想先確認什麼？',
    validation: 'reverse',
    dimensions: ['TF', 'verification', 'ai_collaboration', 'ambiguity_tolerance'],
    options: [
      option('a', '效益是否算得準', '成本、品質與風險數據是否經得起查證', {
        TF: -1,
        verification: 1,
        ai_collaboration: 0.1,
      }, ['效益數據', '數據準不準']),
      option('b', '人如何被支持', '受影響的人是否有參與、轉型與支持方案', {
        TF: 1,
        verification: 0.45,
        ai_collaboration: 1,
      }, ['轉型支持', '受影響的人']),
      option('c', '是否能先做試點', '是否能先做可逆的小規模試點，同時觀察效益與人的影響', {
        TF: 0,
        verification: 0.9,
        ai_collaboration: 0.7,
        ambiguity_tolerance: 0.5,
      }, ['先做試點', '小規模測試']),
    ],
  },
  {
    id: 'q10_monthly_change',
    scenario: '你熟悉的 AI 工具幾乎每個月都改版，原有技巧很快過時。',
    prompt: '你最可能採用哪種做法？',
    validation: 'cross_check',
    dimensions: ['SN', 'transition_speed', 'continuous_learning', 'verification'],
    options: [
      option('a', '追蹤原理與趨勢', '理解底層原理與趨勢，工具改版時再推演新用法', {
        SN: 1,
        transition_speed: 0.7,
        continuous_learning: 0.85,
      }, ['追蹤趨勢', '理解原理']),
      option('b', '維護操作清單', '維護實際操作清單，每次改版就更新步驟', {
        SN: -1,
        transition_speed: 0.45,
        continuous_learning: 0.75,
        verification: 0.45,
      }, ['操作清單', '更新步驟']),
      option('c', '固定用舊版本', '只要還能工作，就盡量維持熟悉的舊做法', {
        SN: -0.35,
        transition_speed: -1,
        continuous_learning: -0.9,
      }, ['維持舊做法', '不想改版']),
    ],
  },
]

export function getQuestion(questionId: string): AieqQuestion | undefined {
  return AIEQ_QUESTIONS.find((question) => question.id === questionId)
}
