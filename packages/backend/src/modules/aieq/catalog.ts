export interface AieqAnimal {
  code: string
  slug: string
  name: string
  title: string
  imagePath: string
  shareCardPath: string
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

const titles: Record<string, string> = {
  ISTJ: '系統築巢者', ISFJ: '溫柔守序者', INFJ: '長線洞察者', INTJ: '策略建築師',
  ISTP: '工具拆解者', ISFP: '體驗守護者', INFP: '價值守望者', INTP: '模型探索者',
  ESTP: '即時行動者', ESFP: '體驗帶動者', ENFP: '機會連結者', ENTP: '創意破框者',
  ESTJ: '落地推進者', ESFJ: '協作織網者', ENFJ: '轉型引導者', ENTJ: '目標整合者',
}

const shareCardFiles: Record<string, string> = {
  ISTJ: '01-istj-beaver.png', ISFJ: '02-isfj-penguin.png', INFJ: '03-infj-elephant.png', INTJ: '04-intj-owl.png',
  ISTP: '05-istp-cat.png', ISFP: '06-isfp-red-panda.png', INFP: '07-infp-deer.png', INTP: '08-intp-octopus.png',
  ESTP: '09-estp-cheetah.png', ESFP: '10-esfp-parrot.png', ENFP: '11-enfp-otter.png', ENTP: '12-entp-crow.png',
  ESTJ: '13-estj-sheepdog.png', ESFJ: '14-esfj-bee.png', ENFJ: '15-enfj-dolphin.png', ENTJ: '16-entj-orca.png',
}

export const AIEQ_ANIMALS: Record<string, AieqAnimal> = Object.fromEntries(
  entries.map(([code, slug, name, strength, blindSpot, growthRoute]) => [code, {
    code,
    slug,
    name,
    title: titles[code],
    imagePath: `/aieq/assets/animals/swiss-modernist/${code.toLowerCase()}-${slug}.png`,
    shareCardPath: `/aieq/design/ai-personality-share-cards-16/${shareCardFiles[code]}`,
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
    title: '證據蒐集中',
    imagePath: '/aieq/assets/animals/swiss-modernist/aieq-16-contact-sheet.png',
    shareCardPath: '/aieq/design/ai-personality-share-cards-16/_contact-sheet.png',
    strength: '仍在蒐集跨情境證據',
    blindSpot: '目前證據不足，不宜過早定型',
    growthRoute: '補充情境後再確認結果',
  }
}
