/**
 * 🛡️ BGFilter — 背景音汙染過濾（三層 defense in depth）
 *
 * 從 voice-pipeline.ts 抽出來的獨立 module — P1 第二個 extraction
 * 2026-06-17 重構：邏輯不動，純拆檔
 *
 * Layer 1 (caller 端): confidence 硬阻擋 — Deepgram 信心 < 0.4 直接丟
 * Layer 2: isBackgroundNoise — 結合 confidence + 廣播 pattern + 超長句
 * Layer 3: isContextuallyIncoherent — 對話脈絡突然出現正式語體 = 廣播
 *
 * 三層獨立、互不依賴，可單獨啟用。
 * 設計戒律：絕對不誤殺正常用戶語音（high-confidence 一律放行）
 */

// 信心分數門檻（公開常數，caller 端用）
export const BG_CONFIDENCE_HARD_REJECT = 0.4;    // 低於此 → caller 端直接丟棄
export const BG_CONFIDENCE_PATTERN_CHECK = 0.6;  // 低於此 → 啟用廣播 pattern 偵測
export const BG_CONFIDENCE_CONTEXT_CHECK = 0.65; // 低於此 → 啟用脈絡一致性檢查

// 單句超過 30 字 + 低信心 → 可疑
const BG_LONG_UTTERANCE_CHARS = 30;

// 廣播/電視/YouTube 特徵 pattern（必須結合低信心才會擋）
const BROADCAST_PATTERNS: RegExp[] = [
  /請.*訂閱/, /點讚.*分享/, /歡迎.*收看/, /歡迎.*回來/,
  /觀眾朋友/, /各位.*觀眾/, /感謝.*收看/, /記得.*按讚/,
  /下一則.*新聞/, /據.*報導/, /本台.*記者/, /廣告.*之後/,
  /記得.*訂閱/, /喜歡.*按讚/, /開啟.*小鈴鐺/,
  /節目.*播出/, /主持人/, /來賓/, /收視率/,
  /不吝.*點贊/, /訂閱.*轉發/, /打賞/,
];

// 第三人稱廣播詞（不像對話的用詞）
const FORMAL_REGISTER_WORDS = [
  '各位', '觀眾', '本台', '記者', '來賓',
  '據報導', '據了解', '本報', '編輯', '主播',
  '節目', '頻道', '收視', '播出',
];

/**
 * 🛡️ BGFilter Layer 2：偵測背景音特徵
 * 結合 confidence + pattern，避免誤殺用戶正常語音
 */
export function isBackgroundNoise(text: string, confidence: number): boolean {
  // 高信心 → 一定是用戶直接說的，放行
  if (confidence >= BG_CONFIDENCE_PATTERN_CHECK) return false;

  // 低信心 + 匹配廣播 pattern → 背景音
  for (const pattern of BROADCAST_PATTERNS) {
    if (pattern.test(text)) return true;
  }

  // 低信心 + 超長句子 → 很可能是背景播放（通話中一句不會說 30+ 字）
  if (confidence < 0.5 && text.length > BG_LONG_UTTERANCE_CHARS) {
    return true;
  }

  return false;
}

/**
 * 🛡️ BGFilter Layer 3：對話脈絡一致性檢查
 * 偵測突然出現的廣播/正式語體詞彙（在低信心條件下）
 *
 * @param text 待檢查的 transcript
 * @param conversationHistory 最近對話歷史（用來看「之前都是口語還是正式」）
 */
export function isContextuallyIncoherent(
  text: string,
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
): boolean {
  // 計算正式語體詞命中數
  let formalHits = 0;
  for (const word of FORMAL_REGISTER_WORDS) {
    if (text.includes(word)) formalHits++;
  }

  // 含 2+ 個正式語體詞 → 非對話語境（新聞、節目等）
  if (formalHits >= 2) return true;

  // 檢查最近對話歷史：如果都是口語風格，突然出現正式語體 → 可疑
  if (formalHits >= 1 && conversationHistory.length >= 2) {
    // 近幾句是否有任何正式語體詞？
    const recentHasFormal = conversationHistory
      .slice(-3)
      .some((h) => FORMAL_REGISTER_WORDS.some((w) => h.content.includes(w)));
    if (!recentHasFormal) return true; // 之前都是口語，突然正式語體 → 背景音
  }

  return false;
}
