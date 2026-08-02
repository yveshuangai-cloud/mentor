/**
 * 🔁 Echo Filter — 投機文字匹配 + Echo Gate（防 AI 自己迴音被當打斷）
 *
 * 從 voice-pipeline.ts 抽出來的獨立 module — P1 第三個 extraction
 * 2026-06-17 重構：邏輯不動，純拆檔
 *
 * 兩個用途：
 *   1. transcriptsMatch — 投機 brain 出來的文字跟 final transcript 是否相符（決定要不要 keep 投機 TTS）
 *   2. isEcho — Deepgram 收到的 transcript 是否其實是 AI 自己 TTS 的迴音（防誤觸打斷）
 */

/**
 * 投機 Brain 文字匹配 — 用 Levenshtein 編輯距離（允許 30% 差異）
 *
 * 🔧 Fix M2: 用 Levenshtein 編輯距離取代逐位元比較
 * 舊版：逐位元比較，一個字元的插入/刪除會導致後面全部不匹配
 * 新版：編輯距離，允許 STT 常見的字元插入/刪除/替換
 */
export function transcriptsMatch(speculative: string, final: string): boolean {
  const a = speculative.replace(/\s+/g, '').toLowerCase();
  const b = final.replace(/\s+/g, '').toLowerCase();
  if (a === b) return true;

  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;

  // 快速路徑：一個包含另一個（STT 常見 — interim 是 final 的前綴或子集）
  if (a.includes(b) || b.includes(a)) return true;

  // Levenshtein 編輯距離（O(n*m)，但語音回覆都很短 ≤ 50 字，無效能問題）
  const dist = levenshtein(a, b);
  return dist / maxLen < 0.3; // 允許 30% 差異（STT 比較容易翻錯）
}

/**
 * Echo Gate：判斷 Deepgram transcript 是否為 AI 的迴音
 * 比對 transcript 和 AI 正在說的文字，模糊匹配（STT 不完美）
 */
export function isEcho(transcript: string, spokenText: string): boolean {
  const a = transcript.replace(/\s+/g, '').toLowerCase();
  const b = spokenText.replace(/\s+/g, '').toLowerCase();
  if (!a || !b) return false;

  // 快速路徑：transcript 是 spoken text 的子字串（最常見的迴音模式）
  if (b.includes(a)) return true;

  // 逐段比對：transcript 的前 N 個字出現在 spoken text 中
  // STT 迴音通常是 spoken text 的片段，但可能有些字翻錯
  const checkLen = Math.min(a.length, 8); // 只看前 8 字就夠判斷
  const fragment = a.slice(0, checkLen);

  // 在 spoken text 中找到最佳匹配位置
  for (let i = 0; i <= b.length - checkLen; i++) {
    let matches = 0;
    for (let j = 0; j < checkLen; j++) {
      if (fragment[j] === b[i + j]) matches++;
    }
    // 75% 以上字元匹配 → 判定為迴音
    if (matches / checkLen >= 0.75) return true;
  }

  return false;
}

/**
 * Levenshtein 編輯距離（給 transcriptsMatch 內部用）
 * 優化：只用兩行（省記憶體）
 */
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n]!;
}
