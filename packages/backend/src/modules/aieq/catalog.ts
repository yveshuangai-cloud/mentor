export interface AieqAnimal {
  code: string
  slug: string
  name: string
  imagePath: string
  strength: string
  blindSpot: string
  growthRoute: string
}

const entries: Array<[string, string, string, string, string, string]> = [
  ['ISTJ', 'beaver', '河狸', '把混亂變成可靠系統', '可能太晚才接受新工具', '用低風險試點替代一次到位'],
  ['ISFJ', 'penguin', '企鵝', '穩定照顧團隊與品質', '可能默默承擔過多轉型成本', '把照顧化成可複製流程'],
  ['INFJ', 'elephant', '大象', '看見長期影響與人的需求', '可能為理想等待完美時機', '用小型原型驗證願景'],
  ['INTJ', 'owl', '貓頭鷹', '設計長期策略與架構', '可能低估導入所需的共識', '讓利害關係人提早參與'],
  ['ISTP', 'cat', '貓', '快速拆解工具與實際問題', '可能略過溝通與文件', '把有效解法留下可重用紀錄'],
  ['ISFP', 'red-panda', '小熊貓', '敏銳察覺體驗與價值衝突', '可能避開過度制度化的改變', '為創作建立最小安全框架'],
  ['INFP', 'deer', '鹿', '守住意義、倫理與人的可能', '可能在選項太多時延遲決定', '設定期限並完成一次可逆實驗'],
  ['INTP', 'octopus', '章魚', '建立模型並探索多條解法', '可能一直研究而未交付', '先交一個能被使用者否定的版本'],
  ['ESTP', 'cheetah', '獵豹', '在變動中快速行動與修正', '可能低估驗證和治理', '在速度流程中加入必要檢查點'],
  ['ESFP', 'parrot', '鸚鵡', '帶動參與並讓新工具容易接近', '可能追逐新鮮感而缺乏沉澱', '每次實驗都留下成果與學習'],
  ['ENFP', 'otter', '水獺', '連結創意、人與新機會', '可能同時展開太多方向', '用一項衡量標準選出下一步'],
  ['ENTP', 'crow', '烏鴉', '挑戰假設並組合新解法', '可能頻繁換題而未完成落地', '替探索設定停止條件與交付點'],
  ['ESTJ', 'sheepdog', '牧羊犬', '組織資源並推動規模化落地', '可能太快把試驗變成規則', '先聽取例外再標準化'],
  ['ESFJ', 'bee', '蜜蜂', '建立協作網絡與採用動能', '可能為共識犧牲必要質疑', '指定一位反方檢查風險'],
  ['ENFJ', 'dolphin', '海豚', '帶領他人理解並共同轉型', '可能替別人承擔成長責任', '把支持轉為對方可自主的能力'],
  ['ENTJ', 'orca', '虎鯨', '整合人才、技術與目標前進', '可能過度壓縮探索和調適時間', '在決策前保留反證與回饋窗口'],
]

export const AIEQ_ANIMALS: Record<string, AieqAnimal> = Object.fromEntries(
  entries.map(([code, slug, name, strength, blindSpot, growthRoute]) => [code, {
    code,
    slug,
    name,
    imagePath: `/aieq/assets/animals/swiss-modernist/${code.toLowerCase()}-${slug}.png`,
    strength,
    blindSpot,
    growthRoute,
  }]),
)

export function animalForCode(code: string): AieqAnimal {
  return AIEQ_ANIMALS[code] ?? {
    code,
    slug: 'explorer',
    name: '探索者',
    imagePath: '/aieq/assets/animals/swiss-modernist/aieq-16-contact-sheet.png',
    strength: '仍在蒐集跨情境證據',
    blindSpot: '目前證據不足，不宜過早定型',
    growthRoute: '補充情境後再確認結果',
  }
}
