export interface AieqAnimal {
  code: string
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
  ['ISTJ', 'beaver', '河狸', '你很會把一團亂的事情，慢慢整理成大家都能照著做的穩定流程。', '新的 AI 工具出現時，你習慣先等它被證明可靠；這份謹慎很珍貴，只是有時等得久了，會錯過一些其實很適合你的好幫手。', '不用一次全部換掉。挑一件風險小的日常工作先試兩週，覺得好用再慢慢擴大，這樣既安心，也不會落後。'],
  ['ISFJ', 'penguin', '企鵝', '你總是默默把事情顧好，也把身邊的人顧好；有你在，團隊用 AI 會更安心，品質也更穩。', '大家在適應新工具時，你常常不知不覺就把麻煩的部分接過來做；你很少喊累，所以別人也不容易發現你其實扛了很多。', '試著把你照顧大家的方法寫成簡單步驟或範本，讓別人也能照著做。你的細心會被留下來，你也能輕鬆一點。'],
  ['INFJ', 'elephant', '大象', '你看事情看得很遠，也看得見人的感受；別人還在想 AI 能做什麼，你已經在想它會怎麼影響大家。', '你心裡常有一個很美的想像，也因此想等一切都準備好再開始；但完美的時機很少自己出現，好點子有時就這樣被放著了。', '先做一個小小的、不完美的版本給一兩個人看看。真實的回饋會讓你的想法更清楚，也更容易一步步成真。'],
  ['INTJ', 'owl', '貓頭鷹', '你很會先看清全局，再把複雜的事情整理成一條走得通的路。', '你腦中常常已經想得很完整，但身邊的人可能還沒跟上；不是大家不支持，而是他們需要多一點時間理解你的想法。', '下一次有新計畫時，試著早一點找一兩位夥伴聊聊。讓他們一起參與，會比你一個人把答案想完更容易往前走。'],
  ['ISTP', 'cat', '貓', '你拿到新工具就想動手拆開來看，很快就能搞懂它怎麼運作，也很快找到真正能解決問題的用法。', '你解決問題的速度很快，快到常常來不及跟別人說你是怎麼做到的；於是好方法只留在你腦中，下次別人還是得來問你。', '問題解決後，花三分鐘把做法記下來，一句話、一張截圖都可以。未來的你和你的夥伴，都會很感謝這個小習慣。'],
  ['ISFP', 'red-panda', '小熊貓', '你對「感覺對不對」很敏銳；AI 做出來的東西哪裡少了一點人味、哪裡讓人不舒服，你往往第一個發現。', '規定太多、流程太硬的改變，會讓你想悄悄退開；這是在保護你的創作空間，只是有時也會讓你錯過能幫上忙的新工具。', '替自己訂幾條最簡單的原則，例如哪些事交給 AI、哪些一定自己來。有了這個小框架，你反而能更自在地嘗試。'],
  ['INFP', 'deer', '鹿', '你很在意一件事「為什麼要做」和「對人好不好」；在大家忙著追新工具時，你會提醒大家別忘了初衷。', '當選擇太多、每一個看起來都有道理時，你容易一直想、一直比較，遲遲下不了決定；不是你不夠果斷，而是你太想選到對的那一個。', '給自己一個期限，先選一個「不喜歡還能改回來」的做法試試看。實際走一小步，答案常常比想像中更快出現。'],
  ['INTP', 'octopus', '章魚', '你喜歡把事情想透，腦中同時能跑好幾條路；遇到 AI 的新問題，你總能想出別人沒想到的解法。', '研究本身對你來說太有趣了，有趣到常常捨不得停下來；東西一直在變好，卻一直還沒交出去。', '先交出一個「可以被人挑毛病」的版本。別人的一句回饋，常常比你自己再多想三天更有用。'],
  ['ESTP', 'cheetah', '獵豹', '情況一變你就跟著動，邊做邊調整；別人還在觀望的時候，你已經用 AI 試出第一個成果了。', '你衝得很快，有時會覺得檢查和確認太拖時間；但 AI 偶爾會很有自信地給出錯的答案，少看那一眼，後面可能要花更多力氣補救。', '不用放慢腳步，只要在流程裡放一兩個固定的檢查點，例如送出前核對一次數字和來源。速度還在，也更站得住腳。'],
  ['ESFP', 'parrot', '鸚鵡', '你很會把氣氛帶起來；再陌生的 AI 工具，經過你一玩一分享，大家就覺得沒那麼難，也想試試看。', '新東西對你來說很有吸引力，玩完這個又想玩下一個；很開心，只是回頭看時，有時想不起來到底留下了什麼。', '每次試完新工具，留下一個小成果和一句心得。累積起來，這些就會變成你獨有的 AI 使用地圖。'],
  ['ENFP', 'otter', '水獺', '你很會把人、點子和新機會串在一起；別人只看到一個 AI 工具，你已經想到它可以幫到誰、還能變出什麼。', '你的靈感來得又多又快，常常同時開了好幾條線；每一條都很有趣，但力氣一分散，就很難有一條真的走到底。', '下次點子太多時，只問自己一個問題，例如「哪一個最能幫到人？」用這個標準選出下一步，其他的先放進口袋。'],
  ['ENTP', 'crow', '烏鴉', '你喜歡問「為什麼一定要這樣？」也很會把不相干的東西組合出新玩法；AI 在你手上，常常被用出說明書沒寫的用途。', '對你來說，想到新點子比把舊點子做完有趣多了；於是題目換得很快，真正落地的卻不多。', '開始探索前，先跟自己約好：試到什麼程度就停、要交出什麼東西。有了終點線，你的創意才會變成看得見的成果。'],
  ['ESTJ', 'sheepdog', '牧羊犬', '你很會把人和資源組織起來，讓事情真的發生；AI 的好點子到了你手上，就能從「試試看」變成大家每天都在用。', '你看到有效的做法，就想趕快變成大家都照做的規定；只是試驗才剛開始時，有些特殊情況還沒浮現，規則定得太早容易卡住人。', '定規則前，先問問大家：「有沒有哪種情況這樣做行不通？」多聽幾個例外，定出來的標準會更耐用。'],
  ['ESFJ', 'bee', '蜜蜂', '你很會把大家連在一起，讓每個人都願意一起試；有你在，新的 AI 工具不會只有少數人在用。', '你很重視大家的和氣與共識，所以有疑慮時，可能會選擇先不說；但 AI 的事情有時就需要有人說一句「等等，這樣真的沒問題嗎？」', '討論時請一位夥伴專門負責「挑毛病」，把質疑變成一個角色，而不是針對誰。這樣既保住氣氛，也顧到風險。'],
  ['ENFJ', 'dolphin', '海豚', '你很會陪著別人一起弄懂新東西；再害怕 AI 的人，在你的帶領下也會慢慢敢用、願意改變。', '你太想幫大家了，有時會不小心把別人該自己練習的部分也一起做完；對方輕鬆了，卻少了自己學會的機會。', '下次幫忙時，試著從「我幫你做」改成「我陪你做一次，下次換你」。你的支持會變成對方真正帶得走的能力。'],
  ['ENTJ', 'orca', '虎鯨', '你很會看準目標，把對的人和對的工具整合起來一起往前；有你帶隊，AI 不會只是玩具，而會變成真的成果。', '你前進的節奏很快，有時會把大家摸索和適應的時間壓得太短；不是大家不想跟，而是他們需要一點時間消化。', '做重要決定前，留一小段時間專門聽「可能哪裡不對」。多這一步，你的決定會更穩，大家也會跟得更甘願。'],
]

const titles: Record<string, string> = {
  ISTJ: '系統築巢者', ISFJ: '溫柔守序者', INFJ: '長線洞察者', INTJ: '策略建築師',
  ISTP: '工具拆解者', ISFP: '體驗守護者', INFP: '價值守望者', INTP: '模型探索者',
  ESTP: '即時行動者', ESFP: '體驗帶動者', ENFP: '機會連結者', ENTP: '創意破框者',
  ESTJ: '落地推進者', ESFJ: '協作織網者', ENFJ: '轉型引導者', ENTJ: '目標整合者',
}

const shareCardFiles: Record<string, string> = {
  ISTJ: '01-istj-beaver.jpg', ISFJ: '02-isfj-penguin.jpg', INFJ: '03-infj-elephant.jpg', INTJ: '04-intj-owl.jpg',
  ISTP: '05-istp-cat.jpg', ISFP: '06-isfp-red-panda.jpg', INFP: '07-infp-deer.jpg', INTP: '08-intp-octopus.jpg',
  ESTP: '09-estp-cheetah.jpg', ESFP: '10-esfp-parrot.jpg', ENFP: '11-enfp-otter.jpg', ENTP: '12-entp-crow.jpg',
  ESTJ: '13-estj-sheepdog.jpg', ESFJ: '14-esfj-bee.jpg', ENFJ: '15-enfj-dolphin.jpg', ENTJ: '16-entj-orca.jpg',
}

export const AIEQ_ANIMALS: Record<string, AieqAnimal> = Object.fromEntries(
  entries.map(([code, slug, name, strength, blindSpot, growthRoute]) => [code, {
    code,
    slug,
    name,
    title: titles[code],
    imagePath: `/aieq/assets/animals/swiss-modernist/${code.toLowerCase()}-${slug}.jpg`,
    resultScenePath: `/aieq/scenes/results/${code.toLowerCase()}-${slug}-v1.jpg`,
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
    imagePath: '/aieq/assets/animals/swiss-modernist/aieq-16-contact-sheet.jpg',
    resultScenePath: '/aieq/scenes/start/start-exploration-v1.jpg',
    shareCardPath: '/aieq/design/ai-personality-share-cards-16/_contact-sheet.jpg',
    strength: '仍在蒐集跨情境證據',
    blindSpot: '目前證據不足，不宜過早定型',
    growthRoute: '補充情境後再確認結果',
  }
}
