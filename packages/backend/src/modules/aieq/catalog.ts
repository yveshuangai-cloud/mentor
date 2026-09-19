export interface AieqAnimal {
  /** Four-letter shorthand shown small beside the animal. */
  displayCode: string
  /** Green subtitle on the share card. */
  tagline: string
  /** One line of 自然優勢, the card's closing block. */
  edge: string
  /** Internal key for one of the 16 combinations, e.g. 'out-idea-logic-flex'. Never shown to players. */
  typeKey: string
  slug: string
  name: string
  title: string
  imagePath: string
  resultScenePath: string
  shareCardPath: string
  strength: string
  blindSpot: string
  growthRoute: string
}

const entries: Array<[string, string, string, string, string, string]> = [
  ['in-real-logic-plan', 'beaver', '河狸', '你很會把一團亂的事情，慢慢整理成大家都能照著做的穩定流程。', '新的 AI 工具出現時，你習慣先等它被證明可靠；這份謹慎很珍貴，只是有時等得久了，會錯過一些其實很適合你的好幫手。', '不用一次全部換掉。挑一件風險小的日常工作先試兩週，覺得好用再慢慢擴大，這樣既安心，也不會落後。'],
  ['in-real-feel-plan', 'penguin', '企鵝', '你總是默默把事情顧好，也把身邊的人顧好；有你在，團隊用 AI 會更安心，品質也更穩。', '大家在適應新工具時，你常常不知不覺就把麻煩的部分接過來做；你很少喊累，所以別人也不容易發現你其實扛了很多。', '試著把你照顧大家的方法寫成簡單步驟或範本，讓別人也能照著做。你的細心會被留下來，你也能輕鬆一點。'],
  ['in-idea-feel-plan', 'elephant', '大象', '你看事情看得很遠，也看得見人的感受；別人還在想 AI 能做什麼，你已經在想它會怎麼影響大家。', '你心裡常有一個很美的想像，也因此想等一切都準備好再開始；但完美的時機很少自己出現，好點子有時就這樣被放著了。', '先做一個小小的、不完美的版本給一兩個人看看。真實的回饋會讓你的想法更清楚，也更容易一步步成真。'],
  ['in-idea-logic-plan', 'owl', '貓頭鷹', '你很會先看清全局，再把複雜的事情整理成一條走得通的路。', '你腦中常常已經想得很完整，但身邊的人可能還沒跟上；不是大家不支持，而是他們需要多一點時間理解你的想法。', '下一次有新計畫時，試著早一點找一兩位夥伴聊聊。讓他們一起參與，會比你一個人把答案想完更容易往前走。'],
  ['in-real-logic-flex', 'cat', '貓', '你拿到新工具就想動手拆開來看，很快就能搞懂它怎麼運作，也很快找到真正能解決問題的用法。', '你解決問題的速度很快，快到常常來不及跟別人說你是怎麼做到的；於是好方法只留在你腦中，下次別人還是得來問你。', '問題解決後，花三分鐘把做法記下來，一句話、一張截圖都可以。未來的你和你的夥伴，都會很感謝這個小習慣。'],
  ['in-real-feel-flex', 'red-panda', '小熊貓', '你對「感覺對不對」很敏銳；AI 做出來的東西哪裡少了一點人味、哪裡讓人不舒服，你往往第一個發現。', '規定太多、流程太硬的改變，會讓你想悄悄退開；這是在保護你的創作空間，只是有時也會讓你錯過能幫上忙的新工具。', '替自己訂幾條最簡單的原則，例如哪些事交給 AI、哪些一定自己來。有了這個小框架，你反而能更自在地嘗試。'],
  ['in-idea-feel-flex', 'deer', '鹿', '你很在意一件事「為什麼要做」和「對人好不好」；在大家忙著追新工具時，你會提醒大家別忘了初衷。', '當選擇太多、每一個看起來都有道理時，你容易一直想、一直比較，遲遲下不了決定；不是你不夠果斷，而是你太想選到對的那一個。', '給自己一個期限，先選一個「不喜歡還能改回來」的做法試試看。實際走一小步，答案常常比想像中更快出現。'],
  ['in-idea-logic-flex', 'octopus', '章魚', '你喜歡把事情想透，腦中同時能跑好幾條路；遇到 AI 的新問題，你總能想出別人沒想到的解法。', '研究本身對你來說太有趣了，有趣到常常捨不得停下來；東西一直在變好，卻一直還沒交出去。', '先交出一個「可以被人挑毛病」的版本。別人的一句回饋，常常比你自己再多想三天更有用。'],
  ['out-real-logic-flex', 'cheetah', '獵豹', '情況一變你就跟著動，邊做邊調整；別人還在觀望的時候，你已經用 AI 試出第一個成果了。', '你衝得很快，有時會覺得檢查和確認太拖時間；但 AI 偶爾會很有自信地給出錯的答案，少看那一眼，後面可能要花更多力氣補救。', '不用放慢腳步，只要在流程裡放一兩個固定的檢查點，例如送出前核對一次數字和來源。速度還在，也更站得住腳。'],
  ['out-real-feel-flex', 'parrot', '鸚鵡', '你很會把氣氛帶起來；再陌生的 AI 工具，經過你一玩一分享，大家就覺得沒那麼難，也想試試看。', '新東西對你來說很有吸引力，玩完這個又想玩下一個；很開心，只是回頭看時，有時想不起來到底留下了什麼。', '每次試完新工具，留下一個小成果和一句心得。累積起來，這些就會變成你獨有的 AI 使用地圖。'],
  ['out-idea-feel-flex', 'otter', '水獺', '你很會把人、點子和新機會串在一起；別人只看到一個 AI 工具，你已經想到它可以幫到誰、還能變出什麼。', '你的靈感來得又多又快，常常同時開了好幾條線；每一條都很有趣，但力氣一分散，就很難有一條真的走到底。', '下次點子太多時，只問自己一個問題，例如「哪一個最能幫到人？」用這個標準選出下一步，其他的先放進口袋。'],
  ['out-idea-logic-flex', 'crow', '烏鴉', '你喜歡問「為什麼一定要這樣？」也很會把不相干的東西組合出新玩法；AI 在你手上，常常被用出說明書沒寫的用途。', '對你來說，想到新點子比把舊點子做完有趣多了；於是題目換得很快，真正落地的卻不多。', '開始探索前，先跟自己約好：試到什麼程度就停、要交出什麼東西。有了終點線，你的創意才會變成看得見的成果。'],
  ['out-real-logic-plan', 'sheepdog', '牧羊犬', '你很會把人和資源組織起來，讓事情真的發生；AI 的好點子到了你手上，就能從「試試看」變成大家每天都在用。', '你看到有效的做法，就想趕快變成大家都照做的規定；只是試驗才剛開始時，有些特殊情況還沒浮現，規則定得太早容易卡住人。', '定規則前，先問問大家：「有沒有哪種情況這樣做行不通？」多聽幾個例外，定出來的標準會更耐用。'],
  ['out-real-feel-plan', 'bee', '蜜蜂', '你很會把大家連在一起，讓每個人都願意一起試；有你在，新的 AI 工具不會只有少數人在用。', '你很重視大家的和氣與共識，所以有疑慮時，可能會選擇先不說；但 AI 的事情有時就需要有人說一句「等等，這樣真的沒問題嗎？」', '討論時請一位夥伴專門負責「挑毛病」，把質疑變成一個角色，而不是針對誰。這樣既保住氣氛，也顧到風險。'],
  ['out-idea-feel-plan', 'dolphin', '海豚', '你很會陪著別人一起弄懂新東西；再害怕 AI 的人，在你的帶領下也會慢慢敢用、願意改變。', '你太想幫大家了，有時會不小心把別人該自己練習的部分也一起做完；對方輕鬆了，卻少了自己學會的機會。', '下次幫忙時，試著從「我幫你做」改成「我陪你做一次，下次換你」。你的支持會變成對方真正帶得走的能力。'],
  ['out-idea-logic-plan', 'orca', '虎鯨', '你很會看準目標，把對的人和對的工具整合起來一起往前；有你帶隊，AI 不會只是玩具，而會變成真的成果。', '你前進的節奏很快，有時會把大家摸索和適應的時間壓得太短；不是大家不想跟，而是他們需要一點時間消化。', '做重要決定前，留一小段時間專門聽「可能哪裡不對」。多這一步，你的決定會更穩，大家也會跟得更甘願。'],
]

const titles: Record<string, string> = {
  'in-real-logic-plan': '系統築巢者', 'in-real-feel-plan': '溫柔守序者', 'in-idea-feel-plan': '長線洞察者', 'in-idea-logic-plan': '策略建築師',
  'in-real-logic-flex': '工具拆解者', 'in-real-feel-flex': '體驗守護者', 'in-idea-feel-flex': '價值守望者', 'in-idea-logic-flex': '模型探索者',
  'out-real-logic-flex': '即時行動者', 'out-real-feel-flex': '體驗帶動者', 'out-idea-feel-flex': '機會連結者', 'out-idea-logic-flex': '創意破框者',
  'out-real-logic-plan': '落地推進者', 'out-real-feel-plan': '協作織網者', 'out-idea-feel-plan': '轉型引導者', 'out-idea-logic-plan': '目標整合者',
}

// The card's green subtitle, and the one-line 自然優勢 the card closes with.
const taglines: Record<string, string> = {
  'in-real-logic-plan': '穩健築系統，讓改變可靠落地', 'in-real-feel-plan': '守住品質與人，讓新工具安心被用',
  'in-idea-feel-plan': '看見長期影響，也照顧人的需要', 'in-idea-logic-plan': '先看全局，再替未來設計架構',
  'in-real-logic-flex': '動手拆解問題，找到最短解法', 'in-real-feel-flex': '守住美感、感受與重要價值',
  'in-idea-feel-flex': '替技術保留意義與人的可能', 'in-idea-logic-flex': '建立模型，探索多條可能路徑',
  'out-real-logic-flex': '在變動中搶先行動、快速修正', 'out-real-feel-flex': '讓新工具變有趣，點燃參與動能',
  'out-idea-feel-flex': '連結創意、人與新的機會', 'out-idea-logic-flex': '換角度，換方法，直到更好的答案',
  'out-real-logic-plan': '整合資源，讓試驗走向規模化', 'out-real-feel-plan': '把關係變成可靠的協作網絡',
  'out-idea-feel-plan': '用對話帶領團隊共同轉型', 'out-idea-logic-plan': '把人才、技術與目標排成隊形',
}
const edges: Record<string, string> = {
  'in-real-logic-plan': '把混亂變成可靠系統', 'in-real-feel-plan': '穩定照顧團隊與品質',
  'in-idea-feel-plan': '看見長期影響與人的需求', 'in-idea-logic-plan': '設計長期策略與架構',
  'in-real-logic-flex': '快速拆解工具與實際問題', 'in-real-feel-flex': '敏銳察覺體驗與價值衝突',
  'in-idea-feel-flex': '守住意義、倫理與人的可能', 'in-idea-logic-flex': '建立模型並探索多條解法',
  'out-real-logic-flex': '在變動中快速行動與修正', 'out-real-feel-flex': '帶動參與並讓新工具容易接近',
  'out-idea-feel-flex': '連結創意、人與新機會', 'out-idea-logic-flex': '挑戰假設並組合新解法',
  'out-real-logic-plan': '組織資源並推動規模化落地', 'out-real-feel-plan': '建立協作網絡與採用動能',
  'out-idea-feel-plan': '帶領他人理解並共同轉型', 'out-idea-logic-plan': '整合人才、技術與目標前進',
}
// A familiar four-letter shorthand for the four axes, shown small beside the animal.
// Product decision by the association's chief planner on 2026-09-19: the letters help people
// read the result, and they carry this product's own definitions, which the page states in words.
const displayCodes: Record<string, string> = {
  'in-real-logic-plan': 'ISTJ', 'in-real-feel-plan': 'ISFJ', 'in-idea-feel-plan': 'INFJ', 'in-idea-logic-plan': 'INTJ',
  'in-real-logic-flex': 'ISTP', 'in-real-feel-flex': 'ISFP', 'in-idea-feel-flex': 'INFP', 'in-idea-logic-flex': 'INTP',
  'out-real-logic-flex': 'ESTP', 'out-real-feel-flex': 'ESFP', 'out-idea-feel-flex': 'ENFP', 'out-idea-logic-flex': 'ENTP',
  'out-real-logic-plan': 'ESTJ', 'out-real-feel-plan': 'ESFJ', 'out-idea-feel-plan': 'ENFJ', 'out-idea-logic-plan': 'ENTJ',
}

const shareCardFiles: Record<string, string> = {
  'in-real-logic-plan': '01-beaver.jpg', 'in-real-feel-plan': '02-penguin.jpg', 'in-idea-feel-plan': '03-elephant.jpg', 'in-idea-logic-plan': '04-owl.jpg',
  'in-real-logic-flex': '05-cat.jpg', 'in-real-feel-flex': '06-red-panda.jpg', 'in-idea-feel-flex': '07-deer.jpg', 'in-idea-logic-flex': '08-octopus.jpg',
  'out-real-logic-flex': '09-cheetah.jpg', 'out-real-feel-flex': '10-parrot.jpg', 'out-idea-feel-flex': '11-otter.jpg', 'out-idea-logic-flex': '12-crow.jpg',
  'out-real-logic-plan': '13-sheepdog.jpg', 'out-real-feel-plan': '14-bee.jpg', 'out-idea-feel-plan': '15-dolphin.jpg', 'out-idea-logic-plan': '16-orca.jpg',
}

export const AIEQ_ANIMALS: Record<string, AieqAnimal> = Object.fromEntries(
  entries.map(([typeKey, slug, name, strength, blindSpot, growthRoute]) => [typeKey, {
    typeKey,
    slug,
    name,
    title: titles[typeKey],
    displayCode: displayCodes[typeKey],
    tagline: taglines[typeKey],
    edge: edges[typeKey],
    imagePath: `/aieq/assets/animals/swiss-modernist/${slug}.jpg`,
    resultScenePath: `/aieq/scenes/results/${slug}-v1.jpg`,
    shareCardPath: `/aieq/design/ai-personality-share-cards-16/${shareCardFiles[typeKey]}`,
    strength,
    blindSpot,
    growthRoute,
  }]),
)

export function animalForCode(typeKey: string): AieqAnimal {
  return AIEQ_ANIMALS[typeKey] ?? {
    typeKey,
    displayCode: '',
    tagline: '再多答幾題，就能看出你的傾向',
    edge: '證據還在蒐集中',
    slug: 'explorer',
    name: '探索者',
    title: '證據蒐集中',
    imagePath: '/aieq/assets/animals/swiss-modernist/aieq-16-contact-sheet.jpg',
    resultScenePath: '/aieq/scenes/start/start-exploration-v1.jpg',
    shareCardPath: '/aieq/design/ai-personality-share-cards-16/_contact-sheet.jpg',
    strength: '仍在蒐集跨情境證據',
    blindSpot: '目前證據不足，不宜過早定型',
    growthRoute: '補充情境後再確認結果',
  }
}
