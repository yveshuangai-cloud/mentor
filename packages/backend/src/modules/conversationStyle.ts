/**
 * LINE 對話的最後一道風格咽喉。
 *
 * 提示詞負責讓模型先說得像人；這裡負責確定性清掉常見 Markdown 痕跡，
 * 再把長文切成接近真人聊天節奏的多個氣泡。
 */

export const CONVERSATION_STYLE_PROMPT = `# LINE 對話節奏（必須遵守）

你正在 LINE 裡聊天，不是在寫報告或文章。
- 先直接回應對方最在意的事；通常用 2 到 6 句就夠。
- 每 2 到 3 句自然停一段。不要把整篇答案塞在同一段。
- 不要使用 Markdown 標題、粗體星號、項目符號、水平線或連續破折號。
- 除非對方明確要求清單、教學步驟或完整分析，否則不要列點、不要編號。
- 正確稱呼是「Yves」；「義父」只是歷史錯字，永遠不要沿用或輸出。
- 句子長短可以有變化，語氣像真人正在回訊息；不要用報告式總結收尾。`

/** 清掉會讓 LINE 訊息看起來像 AI／Markdown 的裝飾符號。 */
export function sanitizeConversationalText(input: string): string {
  return input
    .replace(/義父/g, 'Yves')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*[-*_]{2,}\s*$/gm, '')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/__([^_\n]+)__/g, '$1')
    .replace(/\*/g, '')
    .replace(/([。！？!?])\s*(?:-{2,}|—{2,})\s*/g, '$1')
    .replace(/\s*(?:-{2,}|—{2,})\s*/g, '，')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function sentenceUnits(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
  const units: string[] = []
  for (const paragraph of paragraphs) {
    const sentences = paragraph.match(/[^。！？!?…]+(?:[。！？!?…]+|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? []
    if (sentences.length) units.push(...sentences)
    else if (paragraph) units.push(paragraph)
  }
  return units
}

/**
 * 以 2～3 句、約 180 字為一個氣泡。若媒體訊息佔用 LINE 的五則上限，
 * 超出的文字會合併到最後一個氣泡，確保內容不被截掉。
 */
export function splitIntoLineBubbles(input: string, maxBubbles = 5): string[] {
  const text = sanitizeConversationalText(input)
  if (!text || maxBubbles <= 0) return []

  const units = sentenceUnits(text)
  if (!units.length) return [text]

  const bubbles: string[] = []
  let current: string[] = []
  let currentLength = 0

  const flush = () => {
    if (!current.length) return
    bubbles.push(current.join(''))
    current = []
    currentLength = 0
  }

  for (const unit of units) {
    const wouldBeLong = current.length > 0 && currentLength + unit.length > 180
    if (current.length >= 3 || wouldBeLong) flush()
    current.push(unit)
    currentLength += unit.length
    if (current.length >= 2 && currentLength >= 90) flush()
  }
  flush()

  if (bubbles.length <= maxBubbles) return bubbles
  const kept = bubbles.slice(0, Math.max(0, maxBubbles - 1))
  kept.push(bubbles.slice(Math.max(0, maxBubbles - 1)).join('\n'))
  return kept
}
