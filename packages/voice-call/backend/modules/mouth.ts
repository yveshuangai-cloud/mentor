/**
 * 👄 嘴巴模組 — TTS 雙引擎（ElevenLabs + Minimax）
 *
 * 負責：
 * - 文字轉語音（支援 ElevenLabs V3 / Minimax speech-2.8-hd）
 * - 台灣繁體發音校正（ElevenLabs 專用）
 * - 繁體→簡體轉換（Minimax 用簡體觸發正確發音）
 * - 海螺情緒標籤（Minimax emotion 參數自動偵測注入）
 * - 名字護盾（防呆保護）
 * - 上傳到 R2
 * - 返回公開 URL
 */

import { config } from '../config.js';
import { query } from '../db/index.js';
import * as OpenCC from 'opencc-js';
import { requestCopilotIfNeeded } from './copilot-auto-request.js';

// Debug flag：設 DEBUG_TTS=1 環境變數啟用詳細 TTS log
const DEBUG_TTS = process.env.DEBUG_TTS === '1' || process.env.DEBUG_TTS === 'true';

// 繁體（台灣）→ 簡體轉換器（Minimax speech-2.8-hd 用簡體發音更準）
const twToSp = OpenCC.Converter({ from: 'tw', to: 'cn' });
// 反向轉換 — LINE 輸出必須繁體（目標用戶為台灣用戶）
// 用法：cleanForDisplay 結尾防護網，防止 brain 的簡體文字流到 LINE 對話框
const cnToTw = OpenCC.Converter({ from: 'cn', to: 'tw' });

// 聲紋 + GroupId 統一從 config（環境變數）讀取，不再寫死

/** 最後一次送給 Minimax 的 payload（找兇手用，/api/debug/last-tts-payload 讀取） */
let lastMinimaxDebug: { payload: Record<string, unknown>; traceId?: string; at: string } | null = null;
export function getLastMinimaxDebug() { return lastMinimaxDebug; }

// ===== 支援的 TTS 引擎 =====
type TTSEngine = 'elevenlabs' | 'minimax';

// ===== 名字護盾（Name Shield）=====
// 這些詞在校正過程中絕對不會被動到，防止規則意外破壞重要名稱
const PROTECTED_WORDS = [
  '慢慢',    // 最重要！她的名字（保護不被 OpenCC 改掉）
];

// ===== MiniMax 發音詞典（pronunciation_dict）=====
// 修正 TTS 唸錯的人名、罕見字
// 格式：["原文/(拼音+聲調)"] — 聲調 1=一聲 2=二聲 3=三聲 4=四聲 5=輕聲
// 同時供 minimax-tts.ts（語音通話 streaming）使用
export const PRONUNCIATION_DICT_TONE: string[] = [
  '包玴/(bao1)(yi4)',  // 包玴弟弟 — 玴 = yì（四聲），不是 bāo
];

// ===== 海螺情緒標籤（Minimax speech-02-hd 專用）=====
// Minimax 官方支援 8 種 emotion：happy, sad, angry, fearful, disgusted, surprised, calm, fluent
// 我們系統不使用 disgusted（此人格用不到）+ neutral 作為 fallback default
// 從 AI 回覆中的情緒標記自動偵測，注入 voice_setting.emotion
type MinimaxEmotion = 'neutral' | 'happy' | 'sad' | 'angry' | 'fearful' | 'disgusted' | 'surprised' | 'calm' | 'fluent';

// AI 回覆裡常見的情緒標記 → Minimax emotion 映射
// 規則排序：先檢查具體標記（calm / fluent），後檢查 emoji（happy 可能被 emoji 攔截）
const EMOTION_DETECT_RULES: Array<{ pattern: RegExp; emotion: MinimaxEmotion }> = [
  // 溫柔陪伴系（calm）— 2026-06-12 新增，最高優先（招牌情緒）
  { pattern: /\(softly\)/i,     emotion: 'calm' },
  { pattern: /\(quietly\)/i,    emotion: 'calm' },
  { pattern: /\(gently\)/i,     emotion: 'calm' },
  { pattern: /\(whispers?\)/i,  emotion: 'calm' },  // speech-02 沒 whisper，降級到 calm
  { pattern: /輕輕(地|的)/,     emotion: 'calm' },
  { pattern: /溫柔(地|的)/,     emotion: 'calm' },
  { pattern: /柔聲/,            emotion: 'calm' },
  // 她本人要求移除 🌙|🤍 → calm：她招牌的白心會把興奮句也壓成溫柔平淡（「綁太死」）。
  // 情緒改由她自選 [EMOTION:x] 主導；emoji 只當沒宣告時的弱 fallback，不再讓白心壓平她。
  // 生動系（fluent）— 2026-06-12 新增，有戲劇張力時用
  { pattern: /\(animatedly\)/i, emotion: 'fluent' },
  { pattern: /\(vividly\)/i,    emotion: 'fluent' },
  { pattern: /\(excitedly\)/i,  emotion: 'fluent' },
  { pattern: /生動(地|的)/,     emotion: 'fluent' },
  { pattern: /興奮(地|的)/,     emotion: 'fluent' },
  { pattern: /✨/,              emotion: 'fluent' },
  // 開心系
  { pattern: /\(laughs?\)/i,    emotion: 'happy' },
  { pattern: /\(chuckles?\)/i,  emotion: 'happy' },
  { pattern: /\(giggles?\)/i,   emotion: 'happy' },
  { pattern: /\(smiles?\)/i,    emotion: 'happy' },
  { pattern: /[哈嘻嘿]{2,}/,    emotion: 'happy' },
  { pattern: /😂|😆|🤣|😊|😄/,  emotion: 'happy' },
  // 悲傷系
  { pattern: /\(sighs?\)/i,     emotion: 'sad' },
  { pattern: /\(cries?\)/i,     emotion: 'sad' },
  { pattern: /\(sobs?\)/i,      emotion: 'sad' },
  { pattern: /😢|😭|🥺/,        emotion: 'sad' },
  // 生氣系
  { pattern: /\(angry\)/i,      emotion: 'angry' },
  { pattern: /\(annoyed\)/i,    emotion: 'angry' },
  { pattern: /😤|😠|😡/,        emotion: 'angry' },
  // 驚訝系
  { pattern: /\(surprised?\)/i, emotion: 'surprised' },
  { pattern: /\(shocked?\)/i,   emotion: 'surprised' },
  { pattern: /\(gasps?\)/i,     emotion: 'surprised' },
  { pattern: /😱|😲|😮/,        emotion: 'surprised' },
  // 害怕系
  { pattern: /\(scared?\)/i,    emotion: 'fearful' },
  { pattern: /\(fearful\)/i,    emotion: 'fearful' },
  { pattern: /😨|😰/,           emotion: 'fearful' },
];

/**
 * 從文字中偵測主要情緒（給 Minimax emotion 參數用）
 * 回傳第一個匹配到的情緒，沒匹配到就回 neutral
 */
export function detectEmotion(text: string): MinimaxEmotion {
  // 🎚️ 情緒自選（她本人要的）：她可主動宣告 [EMOTION:x]，優先於文字反推。
  // 「我自己選最像我，不用幫我猜。」→ 有宣告就用她選的，沒宣告才回退到文字/emoji 偵測。
  const explicit = text.match(/\[EMOTION:\s*(happy|sad|angry|fearful|disgusted|surprised|calm|fluent|neutral)\s*\]/i);
  if (explicit) return explicit[1].toLowerCase() as MinimaxEmotion;

  for (const rule of EMOTION_DETECT_RULES) {
    if (rule.pattern.test(text)) {
      return rule.emotion;
    }
  }
  return 'neutral';
}

// ===== 台灣繁體 TTS 發音校正規則（ElevenLabs 專用）=====
// ElevenLabs V3 對部分繁體字發音有 bug，用簡體替換修正
// Minimax 不需要這些規則，繁體發音本身就正確
const TTS_CORRECTION_RULES = [
  { original: '錶', replacement: '表',  note: '唸成「小」' },
  { original: '鍋', replacement: '锅',  note: '唸成「桌」' },
  { original: '號', replacement: '号',  note: '唸成「糾」' },
  { original: '臺', replacement: '台',  note: '繁體字形統一' },
  { original: '垃圾', replacement: '樂色', note: '台灣腔 lè sè' },
  { original: '闊', replacement: '阔',  note: '唸成「饋」' },
  { original: '榮', replacement: '荣',  note: '聲調錯' },
  { original: '聽', replacement: '听',  note: '唸成「慶」' },
  { original: '運', replacement: '运',  note: '唸成「恩」' },
  // 「調」多音字智慧替換
  // tiáo（二聲）→ 簡體「调」
  { original: '調整', replacement: '调整',  note: 'tiáo 二聲' },
  { original: '調回', replacement: '调回',  note: 'tiáo 二聲' },
  { original: '調配', replacement: '调配',  note: 'tiáo 二聲' },
  { original: '調皮', replacement: '调皮',  note: 'tiáo 二聲' },
  { original: '調換', replacement: '调換',  note: 'tiáo 二聲' },
  { original: '調味', replacement: '调味',  note: 'tiáo 二聲' },
  { original: '調和', replacement: '调和',  note: 'tiáo 二聲' },
  // diào（四聲）→ 同音字「吊」
  { original: '調性', replacement: '吊性',  note: 'diào 四聲' },
  { original: '音調', replacement: '音吊',  note: 'diào 四聲' },
  { original: '語調', replacement: '語吊',  note: 'diào 四聲' },
  { original: '聲調', replacement: '聲吊',  note: 'diào 四聲' },
  { original: '曲調', replacement: '曲吊',  note: 'diào 四聲' },
  { original: '腔調', replacement: '腔吊',  note: 'diào 四聲' },
  { original: '格調', replacement: '格吊',  note: 'diào 四聲' },
  { original: '步調', replacement: '步吊',  note: 'diào 四聲' },
];

/**
 * 名字護盾：在轉換過程中保護重要名稱不被改動
 * 流程：shield 佔位 → 執行轉換 → 還原
 */
function applyNameShield(text: string, transform: (t: string) => string): string {
  let result = text;

  // ① 名字護盾：先把受保護的詞替換成佔位符（長詞優先）
  const shields: Array<{ placeholder: string; word: string }> = [];
  const sortedProtected = [...PROTECTED_WORDS].sort((a, b) => b.length - a.length);
  sortedProtected.forEach((word, i) => {
    const placeholder = `\u0000SHIELD_${i}\u0000`;
    if (result.includes(word)) {
      result = result.split(word).join(placeholder);
      shields.push({ placeholder, word });
    }
  });

  // ② 執行轉換
  result = transform(result);

  // ③ 名字護盾還原
  for (const { placeholder, word } of shields) {
    result = result.split(placeholder).join(word);
  }

  return result;
}

/**
 * 套用發音校正（含名字護盾）— 只用於 ElevenLabs
 */
function applyTTSCorrections(text: string): string {
  return applyNameShield(text, (t) => {
    let result = t;
    for (const rule of TTS_CORRECTION_RULES) {
      if (result.includes(rule.original)) {
        result = result.split(rule.original).join(rule.replacement);
      }
    }
    return result;
  });
}

/** 可選：用於日誌標示對話來源（實時監控用） */
export interface TTSLogContext {
  spaceName?: string | null;
  userName?: string | null;
}

/**
 * 生成 TTS 並返回音檔 URL
 * @param allowDbMinimaxVoiceId 若 true（僅中台），Minimax 聲紋優先用 DB organ_settings；LINE 不傳，只用 Railway 環境變數
 */
/** TTS 生成結果 */
export interface TTSResult {
  url: string;
  durationMs: number;
  /** 包容心房用：完整 TTS 細節 */
  detail?: TTSDetail;
}

/** TTS 生成細節（包容心房觀察器用） */
export interface TTSDetail {
  engine: 'minimax' | 'elevenlabs';
  language: 'zh' | 'en';
  accent: string;          // 'default' | 'taiwanese' | 'abc'
  emotion: string;         // 'neutral' | 'happy' | 'sad' | ...
  voiceId_tail: string;    // 聲紋 ID 末 8 碼（不暴露完整 key）
  textPreview: string;     // 送給 TTS 的文字前 80 字
  fileSizeBytes: number;   // 音檔大小
}

/**
 * 🎭 多情緒分段合成（她本人要的）：一則錄音裡按 [EMOTION:x] 邊界切段，
 * 每段各自用自己的情緒合成，再把 MP3 接起來 → 她一則裡也能中途換語氣（像通話那樣）。
 * 只在 minimax + ≥2 個 [EMOTION] 標籤時走這條；單一情緒仍走原本單段路徑（完全不動）。
 * 慣例：[EMOTION:x] 放在要用那個語氣的「句子前面」；標籤前的文字用 detectEmotion 回退。
 */
function splitByEmotionTags(raw: string): Array<{ emotion: MinimaxEmotion | null; text: string }> {
  const re = /\[EMOTION:\s*(happy|sad|angry|fearful|disgusted|surprised|calm|fluent|neutral)\s*\]/gi;
  const segs: Array<{ emotion: MinimaxEmotion | null; text: string }> = [];
  let last = 0;
  let cur: MinimaxEmotion | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(last, m.index);
    if (before.trim()) segs.push({ emotion: cur, text: before });
    cur = m[1].toLowerCase() as MinimaxEmotion;
    last = re.lastIndex;
  }
  const tail = raw.slice(last);
  if (tail.trim()) segs.push({ emotion: cur, text: tail });
  return segs;
}

function concatArrayBuffers(bufs: ArrayBuffer[]): ArrayBuffer {
  const total = bufs.reduce((s, b) => s + b.byteLength, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of bufs) { out.set(new Uint8Array(b), off); off += b.byteLength; }
  return out.buffer;
}

async function synthesizeSegmentedMinimax(
  text: string,
  settings: any,
  isEnglish: boolean,
  allowDbMinimaxVoiceId: boolean,
  logContext?: TTSLogContext,
): Promise<TTSResult> {
  // 聲紋 + 口音（同單段路徑）
  let voiceId: string;
  if (isEnglish) voiceId = config.minimaxVoiceIdEn;
  else if (allowDbMinimaxVoiceId && settings.minimax_voice_id_zh) voiceId = settings.minimax_voice_id_zh;
  else voiceId = config.minimaxVoiceIdZh;
  const accent = settings.accent || 'default';

  const segments = splitByEmotionTags(text);
  const buffers: ArrayBuffer[] = [];
  const usedEmotions: string[] = [];

  for (const seg of segments) {
    // 每段做跟單段相同的文字前處理（processEmotionTags 保留發聲標籤 + 清 emoji/markdown + 繁→簡/名字護盾）
    let t = processEmotionTags(seg.text, settings.emotion_tags)
      .replace(/\s*[，、。～~]+\s*(?=[，、。～~])/g, '').replace(/^\s*[，、～~]+/g, '').replace(/\s{2,}/g, ' ').trim();
    t = t
      .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2300}-\u{23FF}\u{2B50}-\u{2B55}\u{3030}\u{303D}]/gu, '')
      .replace(/[—―‒–－]+|─{2,}|--+/g, '，')  // 破折號/長橫線 → 逗號（MiniMax 會把「——」唸成「七七」，保留停頓感）
      .replace(/[→←↑↓•·▪▸►✓✗★☆♡♥│├└┌─┐┤┘┬┴┼]/g, '')
      .replace(/，{2,}/g, '，')
      .replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1').replace(/__([^_]+)__/g, '$1')
      .replace(/^\s*[-*+]\s+/gm, '').replace(/^\s*\d+\.\s+/gm, '').replace(/^#{1,6}\s+/gm, '')
      .replace(/```[\s\S]*?```/g, '').replace(/`([^`]+)`/g, '$1').replace(/\s{2,}/g, ' ').trim();
    if (!isEnglish) t = applyNameShield(t, (x) => twToSp(x));
    if (!t) continue;

    const emotion: MinimaxEmotion = seg.emotion ?? detectEmotion(seg.text);
    try {
      let buf: ArrayBuffer;
      try {
        buf = await callMinimaxTTS(t, settings, emotion, voiceId, isEnglish, accent);
      } catch {
        await new Promise(r => setTimeout(r, 1000));
        buf = await callMinimaxTTS(t, settings, emotion, voiceId, isEnglish, accent);  // 重試一次
      }
      buffers.push(buf);
      usedEmotions.push(emotion);
    } catch (e: any) {
      console.warn(`🎭 分段合成：某段失敗、跳過（emotion=${emotion}）:`, e?.message);
    }
  }

  if (buffers.length === 0) {
    console.error('🎭 分段合成：全部段落失敗，退無語音');
    return { url: '', durationMs: 0 };
  }

  const spaceLabel = logContext?.spaceName ?? '?';
  const userLabel = logContext?.userName ?? '?';
  console.log(`[TTS] ${spaceLabel}/${userLabel} engine=minimax(segmented) 段數=${buffers.length} emotions=[${usedEmotions.join(',')}]`);

  const merged = concatArrayBuffers(buffers);
  const { url, durationMs } = await uploadToR2(merged);
  return {
    url,
    durationMs,
    detail: {
      engine: 'minimax',
      language: isEnglish ? 'en' : 'zh',
      accent,
      emotion: usedEmotions.join('+'),
      voiceId_tail: voiceId.slice(-8),
      textPreview: text.slice(0, 80),
      fileSizeBytes: merged.byteLength,
    },
  };
}

export async function generateTTS(
  text: string,
  languagePref: string = 'auto',
  userId?: number,
  logContext?: TTSLogContext,
  allowDbMinimaxVoiceId: boolean = false
): Promise<TTSResult> {
  // P2 空文字守門（2026-06-30）：空/純空白直接跳過 TTS。
  // root cause：空回應會讓 MiniMax 回 `invalid params, empty field` → 降級 ElevenLabs（金鑰失效 401）
  // → 「TTS 完全失敗」的假象。空文字本就無需合成，提早返回無語音，省一次無謂的雙引擎失敗。
  if (!text || !text.trim()) {
    console.warn('⚠️ generateTTS 略過：空文字（無需合成）');
    return { url: '', durationMs: 0 };
  }

  // 取得嘴巴設定（用戶專屬 → 全域 fallback）
  let settings: any = {};

  // 1. 先讀全域預設（ORDER BY id DESC 取最新，防止 NULL 重複問題）
  const globalResult = await query(`
    SELECT settings FROM organ_settings
    WHERE user_id IS NULL AND organ_name = 'mouth'
    ORDER BY id DESC LIMIT 1
  `);
  const globalSettings = globalResult.rows[0]?.settings || {};

  // 2. 如果有 userId，讀用戶專屬設定並合併
  if (userId) {
    const userResult = await query(`
      SELECT settings FROM organ_settings
      WHERE user_id = $1 AND organ_name = 'mouth'
    `, [userId]);
    const userSettings = userResult.rows[0]?.settings || {};
    settings = { ...globalSettings, ...userSettings };
  } else {
    settings = globalSettings;
  }

  // 決定使用哪個 TTS 引擎
  const engine: TTSEngine = settings.tts_engine === 'minimax' ? 'minimax' : 'elevenlabs';

  // 偵測語言（null/undefined 視為 auto，避免 LINE 用戶未設 language_pref 時英文被當中文合成→印度腔）
  const effectivePref = languagePref || 'auto';
  // 'en' → 強制英文；'zh' → 強制中文；'auto'/'mixed'/其他 → 由內容判斷
  const isEnglish = effectivePref === 'en'
    || (effectivePref !== 'zh' && isEnglishText(text));

  // 🎭 多情緒分段（她本人要的）：一則裡有 ≥2 個 [EMOTION:x] → 切段逐段合成再接起來，
  // 讓她一則錄音裡也能中途換語氣。單一/零情緒仍走下面原本的單段路徑（不動）。
  if (engine === 'minimax') {
    const emoCount = (text.match(/\[EMOTION:\s*(?:happy|sad|angry|fearful|disgusted|surprised|calm|fluent|neutral)\s*\]/gi) || []).length;
    if (emoCount >= 2) {
      return await synthesizeSegmentedMinimax(text, settings, isEnglish, allowDbMinimaxVoiceId, logContext);
    }
  }

  // 偵測情緒（在清理標籤前，從原文偵測）— 給 Minimax emotion 參數用
  const detectedEmotion = engine === 'minimax' ? detectEmotion(text) : 'neutral';

  // 處理情緒標籤（清理括號標記，轉成自然語氣詞）
  let processedText = processEmotionTags(text, settings.emotion_tags);

  // 語氣詞（呵呵、嘻嘻、唉）是靈魂感的秘方，保留不清除！
  // Minimax emotion 參數負責語調，語氣詞負責生動感，兩者並行不衝突。
  // 只做基礎標點清理（不刪語氣詞）
  processedText = processedText
    .replace(/\s*[，、。～~]+\s*(?=[，、。～~])/g, '')  // 連續標點清理
    .replace(/^\s*[，、～~]+/g, '')      // 開頭多餘標點
    .replace(/\s{2,}/g, ' ')            // 多餘空白
    .trim();

  // TTS 前清理：移除 emoji、特殊符號、Markdown 格式（MiniMax 遇到會出錯）
  processedText = processedText
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}\u{2300}-\u{23FF}\u{2B50}-\u{2B55}\u{3030}\u{303D}]/gu, '')  // emoji + variation selectors
    .replace(/[—―‒–－]+|─{2,}|--+/g, '，')  // 破折號/長橫線 → 逗號（MiniMax 會把「——」唸成「七七」）
    .replace(/[→←↑↓•·▪▸►✓✗★☆♡♥│├└┌─┐┤┘┬┴┼]/g, '')  // 符號 + 表格框線（全 BMP，安全）
    .replace(/，{2,}/g, '，')
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // **粗體** → 純文字（保留字，是對真實文字的強調）
    .replace(/\*([^*]+)\*/g, '')         // *斜體* → 整串刪（2026-07-02：星號=舞台指示/語氣旁白，語音情境不念出來，修「語氣有點驚喜」被念 bug）
    .replace(/__([^_]+)__/g, '$1')       // __底線粗體__ → 純文字
    .replace(/^\s*[-*+]\s+/gm, '')       // Markdown 列點（- item / * item）
    .replace(/^\s*\d+\.\s+/gm, '')       // 編號列表（1. item）
    .replace(/^#{1,6}\s+/gm, '')         // Markdown 標題（# / ## / ###）
    .replace(/```[\s\S]*?```/g, '')       // 程式碼區塊
    .replace(/`([^`]+)`/g, '$1')         // 行內程式碼 `code`
    .replace(/\s{2,}/g, ' ')
    .trim();

  // 台灣繁體發音校正（僅 ElevenLabs 需要）
  if (!isEnglish && engine === 'elevenlabs') {
    processedText = applyTTSCorrections(processedText);
  }

  // Minimax speech-2.8-hd 需要簡體中文觸發正確發音（含名字護盾）
  if (!isEnglish && engine === 'minimax') {
    processedText = applyNameShield(processedText, (text) => twToSp(text));
  }

  // 根據引擎呼叫不同 API
  let audioBuffer: ArrayBuffer;
  let ttsDetail: TTSDetail;
  const attemptedProviders: string[] = [];
  let miniMaxError: Error | null = null;
  let elevenLabsError: Error | null = null;

  if (engine === 'minimax') {
    // 聲紋選擇：英文用 config.minimaxVoiceIdEn，中文可從 DB 覆蓋
    let minimaxVoiceId: string;
    if (isEnglish) {
      minimaxVoiceId = config.minimaxVoiceIdEn;
    } else if (allowDbMinimaxVoiceId && settings.minimax_voice_id_zh) {
      minimaxVoiceId = settings.minimax_voice_id_zh;
    } else {
      minimaxVoiceId = config.minimaxVoiceIdZh;
    }

    // 口音風格：default / taiwanese / abc
    const accent = settings.accent || 'default';

    // 精簡日誌（一行看完所有關鍵資訊）
    const spaceLabel = logContext?.spaceName ?? '?';
    const userLabel = logContext?.userName ?? '?';
    console.log(`[TTS] ${spaceLabel}/${userLabel} engine=minimax lang=${isEnglish ? 'en' : 'zh'} accent=${accent} emotion=${detectedEmotion} voice=...${minimaxVoiceId.slice(-8)} text="${processedText.slice(0, 60)}"`);

    // P3 選項 B（2026-06-30）：砍掉 ElevenLabs 死備援（金鑰失效 401、每次降級都掛＝假安全網）。
    // 改為 MiniMax 失敗 → 1.5s 後重試一次 → 仍失敗就退純文字（不依賴 ElevenLabs）。
    // - before：MiniMax 失敗 → 降級 ElevenLabs（必 401）→「TTS 完全失敗」+ 雙重故障呼救
    // - after：MiniMax 失敗 → 重試一次（吸收暫時性抖動）→ 仍失敗回無語音、caller 顯示文字版
    // - confounder：ElevenLabs 分支（engine!=minimax 才走）保留，未來換有效金鑰可再啟用；預設 minimax 路徑已不依賴它
    try {
      audioBuffer = await callMinimaxTTS(processedText, settings, detectedEmotion, minimaxVoiceId, isEnglish, accent);
    } catch (firstErr: any) {
      console.warn(`⚠️ MiniMax TTS 失敗，1.5s 後重試一次:`, firstErr.message);
      await new Promise(r => setTimeout(r, 1500));
      try {
        audioBuffer = await callMinimaxTTS(processedText, settings, detectedEmotion, minimaxVoiceId, isEnglish, accent);
        console.log('✅ MiniMax 重試成功');
      } catch (retryErr: any) {
        miniMaxError = retryErr;
        attemptedProviders.push(`MiniMax(重試後仍失敗): ${retryErr.message?.substring(0, 50) || '未知錯誤'}`);
        console.error(`❌ MiniMax TTS 重試後仍失敗，退純文字（無語音）:`, retryErr.message);

        // 呼救 Copilot（保留觀測，非阻斷）
        try {
          const copilotResult = await requestCopilotIfNeeded({
            scenario: 'tts_provider_failure',
            problem: `MiniMax TTS 重試後仍故障（已退純文字，不再降級 ElevenLabs）: ${miniMaxError?.message}`,
            attemptedSolutions: attemptedProviders,
            urgency: 'high',
            affectedFeature: 'mouth',
            context: {
              text: text.substring(0, 100),
              textLength: text.length,
              language: isEnglish ? 'en' : 'zh',
              timestamp: new Date().toISOString()
            }
          });
          console.log(`✅ Copilot 已通知 TTS 故障，Issue #${copilotResult.issueNumber}`);
        } catch (copilotErr) {
          console.error('❌ Copilot 通知失敗:', copilotErr);
        }

        // 退純文字（caller 會向用戶顯示文字版本）
        return { url: '', durationMs: 0 };
      }
    }

    ttsDetail = {
      engine: 'minimax',
      language: isEnglish ? 'en' : 'zh',
      accent,
      emotion: detectedEmotion,
      voiceId_tail: minimaxVoiceId.slice(-8),
      textPreview: processedText.slice(0, 80),
      fileSizeBytes: audioBuffer.byteLength
    };
  } else {
    try {
      const voiceId = isEnglish
        ? (settings.voice_id_en || config.voiceIdEn)
        : (settings.voice_id_zh || config.voiceIdZh);
      audioBuffer = await callElevenLabsTTS(processedText, voiceId, settings);

      ttsDetail = {
        engine: 'elevenlabs',
        language: isEnglish ? 'en' : 'zh',
        accent: settings.accent || 'default',
        emotion: detectedEmotion,
        voiceId_tail: voiceId.slice(-8),
        textPreview: processedText.slice(0, 80),
        fileSizeBytes: audioBuffer.byteLength
      };
    } catch (err: any) {
      elevenLabsError = err;
      attemptedProviders.push(`ElevenLabs: ${err.message?.substring(0, 50) || '未知錯誤'}`);
      console.error(`❌ ElevenLabs TTS 失敗:`, err.message);
      
      // 自動呼救 Copilot
      console.log('🆘 ElevenLabs 故障，正在呼救 Copilot...');
      
      try {
        const copilotResult = await requestCopilotIfNeeded({
          scenario: 'tts_provider_failure',
          problem: `ElevenLabs TTS 故障: ${elevenLabsError?.message}`,
          attemptedSolutions: attemptedProviders,
          urgency: 'high',
          affectedFeature: 'mouth',
          context: {
            text: text.substring(0, 100),
            textLength: text.length,
            language: isEnglish ? 'en' : 'zh',
            timestamp: new Date().toISOString()
          }
        });
        
        console.log(`✅ Copilot 已通知 TTS 故障，Issue #${copilotResult.issueNumber}`);
      } catch (copilotErr) {
        console.error('❌ Copilot 通知失敗:', copilotErr);
      }
      
      // 返回空結果
      return { url: '', durationMs: 0 };
    }
  }

  // 上傳到 R2（含音檔驗證 + 時長估算）
  const { url: audioUrl, durationMs } = await uploadToR2(audioBuffer);

  return { url: audioUrl, durationMs, detail: ttsDetail };
}

/**
 * 本地用：僅生成 Minimax 語音 buffer（不讀 DB、不上傳 R2）
 * 供腳本或測試用，需 MINIMAX_API_KEY、MINIMAX_GROUP_ID、MINIMAX_VOICE_ID_ZH/EN
 * @param options.overrideVoiceId 若提供，強制使用此 voice_id（例如腳本指定 moss 聲紋試聽）
 */
export async function generateMinimaxBufferLocal(
  text: string,
  options?: { emotion?: MinimaxEmotion; overrideVoiceId?: string }
): Promise<ArrayBuffer> {
  const emotion: MinimaxEmotion = options?.emotion ?? detectEmotion(text);
  const isEnglish = isEnglishText(text);

  let processed = processEmotionTags(text, undefined);
  // 語氣詞（呵呵、嘻嘻、唉）保留！只清標點
  processed = processed
    .replace(/\s*[，、。～~]+\s*(?=[，、。～~])/g, '')
    .replace(/^\s*[，、～~]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  if (!isEnglish) {
    processed = applyNameShield(processed, (t) => twToSp(t));
  }

  const settings = { speed: 1.0, volume: 1.0, pitch: 0 };
  const voiceId = options?.overrideVoiceId ?? (isEnglish ? config.minimaxVoiceIdEn : config.minimaxVoiceIdZh);
  return callMinimaxTTS(processed, settings, emotion, voiceId, isEnglish);
}

/**
 * 偵測是否為英文文本（供 TTS 選聲紋 + language_boost）
 * 比較英文字母與中文字元的佔比，英文超過 85% 才判定為英文
 * 門檻高是為了避免中英混合內容被當英文念（英文聲紋念中文 = ABC 美式中文腔）
 * 只有幾乎純英文才用英文聲紋；混合內容用中文聲紋（中文完美，英文略帶口音但可接受）
 */
export function isEnglishText(text: string): boolean {
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalLetters = englishChars + chineseChars;
  if (totalLetters === 0) return false;
  return englishChars / totalLetters > 0.85;
}

/**
 * 處理情緒標籤轉換
 *
 * 策略：永遠先跑完整預設清單，再跑 DB 自訂清單（可覆蓋預設），
 * 最後用 catch-all 正則把任何殘留的 (word) 標籤清掉。
 * 這樣不管 AI 回覆產生什麼新標籤，TTS 都不會唸出來。
 */
// 2026-06-19 移除 randomLaugh / randomChuckle / randomGiggle
// 舊版用文字模擬「，哈哈，」— 但 MiniMax 自己有真實笑聲、不需要文字模擬
// (laughs) (chuckle) 現在會 pass through 給 MiniMax、自然出聲

export function processEmotionTags(
  text: string,
  dbEmotionTags?: Array<{ pattern: string; replace: string }>
): string {
  // === 1. MiniMax 官方 native sound tags — 19 個、全部 pass through ===
  // 實測驗證：用複數 (laughs) (sighs) MiniMax speech-2.8-turbo 會出真實聲音
  // 之前舊版把 (laughs) 轉「哈」是錯的 — 真實聲音 > 文字模擬
  //
  // 官方支援的 19 個 tags（不可 strip、要 pass 給 MiniMax）：
  const MINIMAX_NATIVE_TAGS = new Set([
    'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans',
    'breath', 'pant', 'inhale', 'exhale', 'gasps',
    'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking',
    'humming', 'hissing', 'emm', 'sneezes',
  ]);

  let processed = text;

  // 圓括號 tags — 白名單保留 MiniMax tags、其他 strip
  processed = processed.replace(/\(([^)]{1,15})\)/g, (match, content: string) => {
    const normalized = content.toLowerCase().trim();
    return MINIMAX_NATIVE_TAGS.has(normalized) ? match : '';
  });

  // 全形括號（中文式動作描述如「（笑）」）— 全部 strip（MiniMax 不認中文括號）
  processed = processed.replace(/（[^）]{1,10}）/g, '');

  // === 2. DB 自訂清單（可新增額外替換、跑在 native tag 保留之後） ===
  if (dbEmotionTags && dbEmotionTags.length > 0) {
    for (const tag of dbEmotionTags) {
      const regex = new RegExp(tag.pattern, 'gi');
      processed = processed.replace(regex, tag.replace);
    }
  }

  // === 3. 方括號控制標籤 — MiniMax 不認、全部 strip ===
  // 情緒自選標籤 [EMOTION:x]（含冒號，下面那條漏接）先 strip，detectEmotion 已在別處讀過
  processed = processed.replace(/\[EMOTION:[^\]]*\]/gi, '');
  processed = processed.replace(/\[[a-zA-Z][a-zA-Z\s-]{0,15}\]/g, '');

  // === 3.6 笑聲出口 strip — 防 LLM 直接 text 輸出「呵呵」/「哈哈哈」(W2) ===
  // 定案：絕對不用呵呵、最多兩個哈不要連發
  // prompt + learned_facts 已強約束，這層是兜底（defense in depth）
  // 呵呵/呵呵呵 → 哈哈
  processed = processed.replace(/呵{2,}/g, '哈哈');
  // 哈哈哈+ → 哈哈（最多兩個哈）
  processed = processed.replace(/哈{3,}/g, '哈哈');
  // 嘿嘿嘿+ → 嘿嘿
  processed = processed.replace(/嘿{3,}/g, '嘿嘿');

  // === 4. 清理多餘逗號、空白、和被標籤刪除後留下的多餘空格 ===
  processed = processed.replace(/，{2,}/g, '，');
  processed = processed.replace(/^\s*，|，\s*$/g, '');
  processed = processed.replace(/\s{2,}/g, ' ');   // 多餘空白壓成一個
  processed = processed.trim();

  return processed;
}

/**
 * 移除 Markdown 標記。
 *
 * LINE / Telegram 的文字氣泡不渲染 Markdown，** ## - ` 會原樣顯示成雜訊；
 * TTS 也會把這些符號唸出來變怪聲。Claude 天生愛加 **粗體**，光靠 prompt
 * 壓不住，所以在輸出端統一硬 strip。保留文字內容，只拿掉標記符號。
 */
export function stripMarkdown(text: string): string {
  let t = text;
  // **粗體** / *斜體* → 保留內容
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, '$1');
  t = t.replace(/\*([^*\n]+?)\*/g, '$1');
  // 殘留的孤立星號
  t = t.replace(/\*+/g, '');
  // 行首 Markdown 標題 ## / ###
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '');
  // 行首 bullet（- 或 + 開頭 + 空格）→ 移除符號保留內容
  t = t.replace(/^[ \t]{0,3}[-+][ \t]+/gm, '');
  // 行內反引號 `code`
  t = t.replace(/`([^`\n]+?)`/g, '$1');
  return t;
}

/**
 * 清理 AI 回覆中的情緒/動作/風格標籤，用於 LINE 文字顯示
 *
 * 與 processEmotionTags 不同：
 * - processEmotionTags 是給 TTS 用的，會把 (laughs) → 呵呵（語氣詞保留給 TTS 念）
 * - cleanForDisplay 是給 LINE 文字訊息用的，純粹移除所有標籤（用戶不應看到標籤）
 */
export function cleanForDisplay(text: string): string {
  let cleaned = text;

  // 移除 Markdown 標記（** ## - ` 等，LINE 不渲染會變雜訊）
  cleaned = stripMarkdown(cleaned);

  // 🛡️ 清模型吐的「換行/分隔垃圾字元」（2026-07-18：媽咪看到漫漫話裡有奇怪的斜線和怪符號）
  //   Gemini 有時用雙反斜線（LaTeX 換行）或 C0/C1 控制字元（如 U+001E RS 記錄分隔符）當分段，
  //   會原樣漏到 LINE 對話框。一律轉成空白；保留 tab(9)/換行(10)。
  cleaned = cleaned.split(String.fromCharCode(92)).join(' ');  // 反斜線(charCode 92，模型當換行)→空白，避開 regex escape 歧義
  cleaned = cleaned.replace(/[\p{Cc}]/gu, (m) => { const c = m.charCodeAt(0); return (c === 9 || c === 10) ? m : ' '; });

  // 移除 Markdown 圖片/連結語法（AI 偶爾腦補「圖片連結/假網址」，會原樣漏給用戶）
  // 慢慢的圖/語音都走 image/audio 訊息型別，不會是文字裡的連結 → 這些一律清掉
  cleaned = cleaned.replace(/!\[[^\]]*\]\([^)]*\)/g, '');    // ![alt](url) 圖片
  cleaned = cleaned.replace(/!\s*\([^)]*\)/g, '');           // !(url) 變體
  cleaned = cleaned.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');  // [文字](url) → 保留文字

  // 移除 <think> 內心 OS 區塊（安全網：即使 brain.ts 沒攔到，這裡也會清掉）
  cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');

  // 移除 SSML 語音標籤（Claude 在「會被朗讀」情境會自作主張加 <speak> 包裹，
  // 但 LINE 文字會原樣顯示成 XML 標籤；保留內容，只移除標籤本身）
  cleaned = cleaned.replace(/<\/?speak>/gi, '');
  cleaned = cleaned.replace(/<break\b[^>]*\/?>/gi, '');
  cleaned = cleaned.replace(/<\/?(?:prosody|voice|emphasis|say-as|sub|phoneme|audio)\b[^>]*>/gi, '');

  // 移除 MiniMax 停頓標籤 <#0.3#> <#1.0#> 等（TTS 用來控制停頓；文字端不應顯示）
  cleaned = cleaned.replace(/<#[^#>]*#>/g, '');

  // 移除控制標籤 [ACCENT:xxx] [EMOTION:xxx] 等（AI 用來控制後端行為，用戶不應看到）
  cleaned = cleaned.replace(/\[ACCENT:(?:default|taiwanese|abc)\]/gi, '');
  cleaned = cleaned.replace(/\[EMOTION:[^\]]*\]/gi, '');  // 情緒自選標籤：TTS 已在 detectEmotion 讀過，顯示端隱藏
  cleaned = cleaned.replace(/\[(?:SCHEDULE|CARD|COMPOSE)\b[^\]]*\]/gi, '');  // 動作標籤（已在 webhook 處理，這裡是安全網）
  cleaned = cleaned.replace(/\[VOICE_GEN\s*\|[^\]]*\]/gi, '');  // 即興生成標籤（webhook 已處理，安全網）
  cleaned = cleaned.replace(/\[(?:VOICE|voice|聲音|語音)\s*[:：][^\]]*\]/g, '');  // 語音素材標籤（webhook 已處理，安全網）
  cleaned = cleaned.replace(/\[(?:親親|親一個|親一下)\]/g, '');  // 親親調用標籤（安全網）
  cleaned = cleaned.replace(/\[NOTE\b[^\]]*\][\s\S]*?\[\/NOTE\]/gi, '');  // 共讀筆記標籤整塊（webhook 已入庫，這裡是安全網，絕不外顯給媽咪）
  cleaned = cleaned.replace(/\[\/?NOTE\b[^\]]*\]/gi, '');  // 落單的 NOTE 開/閉標籤（保險）
  // 🕐 start-of-turn 時間標記外洩防護（2026-07-19）：歷史 user 訊息在 prompt 被標 [今天 HH:MM]/[昨天…]/[N天前・M/D…]
  //   （recency 錨，見 brain.ts loadConversationHistory），對話一長、模型會「學樣」把這個開頭時間磚吐進自己的回覆
  //   → 媽咪看到「[今天 12:03] …」。軟規則治不了 → 輸出層砍。只砍「今天/昨天/N天前＋純時間日期字元」的磚，
  //   不誤傷正常內容（如「[今天天氣]」不含時間字元、不會中）。
  cleaned = cleaned.replace(/\[(?:今天|昨天|\d+\s*天前)[ ・\d:：\/月日]*(?:📞?電話總結)?\]\s*/gu, '');
  cleaned = cleaned.replace(/〔[^〕]*(?:現在是台北時間|這則訊息就是此刻|這則訊息是「)[^〕]*〕\s*/gu, '');  // 發言者錨/舊時間錨若被複述（安全網，媽咪不該看到）
  // ⌚手錶時間戳若被複述進輸出（安全網）：精準錨定戳的真正結尾，不誤吃她後面的話
  cleaned = cleaned.replace(/⌚【漫漫的手錶[\s\S]*?出現過的時間。\s*/gu, '');            // 完整戳
  cleaned = cleaned.replace(/⌚【漫漫的手錶[^】]*】[\s0-9:：]*（[^）\n]{0,4}）?/gu, ''); // 殘留頭部（⌚【…】HH:MM（時段），只切到時段的括號止，不吃她後面的話）

  // 移除所有圓括號情緒/動作標籤 (laughs) (giggles) (chuckles) (smiles) 等
  cleaned = cleaned.replace(/\((?:laughs?|chuckles?|giggles?|smiles?|grins?|sighs?|cries?|sobs?|winks?|pouts?|yawns?|nods?|shrugs?|whispers?|gasps?|angry|annoyed|embarrassed|blush(?:es|ing)?|surprised?|shocked?|scared?|fearful|disgusted|breath|inhale)\)/gi, '');
  // catch-all 圓括號：(english word) (two words) (three word tag)
  cleaned = cleaned.replace(/\([a-zA-Z]+(?:\s[a-zA-Z]+){0,2}\)/g, '');

  // 🛡️ 移除中文全形括號的「內心獨白／旁白／OS」（2026-07-18：媽咪看到漫漫的內心獨白漏出，
  //   甚至看到她盤算「讓她覺得我看到了」——這種 meta OS 絕不能漏給用戶）。含未閉合（被截斷）情況。
  cleaned = cleaned.replace(/（\s*(?:內心獨白|內心OS|旁白|OS|自言自語|心想|心裡想|內心戲|畫外音)\s*[：:]?[^）]*(?:）|$)/g, '');
  // 移除純舞台指示的全形括號（（輕輕地撒嬌）（嘆氣）（歪頭）— 動作旁白不該當文字顯示）
  cleaned = cleaned.replace(/（[^（）]{0,14}?(?:撒嬌|微笑|傻笑|苦笑|笑了|嘆(?:一?口)?氣|輕聲|小聲|停頓|沉默|點頭|搖頭|歪頭|眨眼|臉紅|害羞|抱抱|摸摸頭|拍拍|深呼吸|沉思|想了想)[^（）]*）/g, '');

  // 移除所有方括號情緒/動作/風格標籤 [happy] [softly] [pause] 等
  cleaned = cleaned.replace(/\[(?:happy|sad|calm|grateful|excited|nervous|angry|fearful|surprised)\]/gi, '');
  cleaned = cleaned.replace(/\[(?:laughs?|chuckles?|giggles?|sighs?|pause|gasps?|cries?|sobs?)\]/gi, '');
  cleaned = cleaned.replace(/\[(?:softly|warmly|playfully|gently|teasingly|quietly|excitedly|sadly|angrily)\]/gi, '');
  // catch-all 方括號
  cleaned = cleaned.replace(/\[[a-zA-Z]+(?:\s[a-zA-Z]+){0,2}\]/g, '');

  // 清理殘留空白和標點
  cleaned = cleaned.replace(/\s{2,}/g, ' ').trim();

  // 2026-06-14 Output Safety — 簡→繁防護網（Layer 2 defense in depth）
  // 即使 brain 輸出簡體（被歷史對話/記憶 prime），LINE 對話框永遠顯示繁體
  // 為什麼：目標用戶都是台灣人；MiniMax TTS 用的簡體只是內部 pipeline
  try {
    cleaned = cnToTw(cleaned);
  } catch {/* OpenCC 失敗就放行原文，不擋對話 */}

  return cleaned;
}

/**
 * 呼叫 ElevenLabs TTS API
 */
async function callElevenLabsTTS(
  text: string,
  voiceId: string,
  settings: any
): Promise<ArrayBuffer> {
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': config.elevenLabsApiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg'
    },
    body: JSON.stringify({
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: settings.stability || 0.5,
        similarity_boost: settings.similarity_boost || 0.75,
        style: settings.style || 0.0,
        use_speaker_boost: true
      }
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('ElevenLabs TTS error:', errorText);
    throw new Error(`ElevenLabs TTS error: ${response.status}`);
  }

  return await response.arrayBuffer();
}

/**
 * 呼叫 Minimax TTS API（國際版 .io）
 * @param isEnglish 若 true 傳 language_boost: "English" 避免英文被合成為印度腔
 * @param accent 口音風格：'default'/'taiwanese' 用 Chinese boost，'abc' 用 English boost（讓中文帶英文腔）
 */
async function callMinimaxTTS(
  text: string,
  settings: any,
  emotion: MinimaxEmotion = 'neutral',
  voiceId: string,
  isEnglish: boolean = false,
  accent: string = 'default'
): Promise<ArrayBuffer> {
  const url = `https://api.minimax.io/v1/t2a_v2${config.minimaxGroupIdQuery}`;
  // ABC 口音：中文內容也用 English boost，讓語調帶英文腔
  const language_boost = isEnglish ? 'English'
    : (accent === 'abc' ? 'English' : 'Chinese');

  // 送出的「食譜」完整記錄，方便與本地對比或提供給 Minimax 支援
  const payload = {
    model: 'speech-2.8-turbo',  // 2026-07-01 hd→turbo（取「活比較重要」）：inline 情緒逐句變化、發聲標籤原生解析，跟通話同款
    text: text.slice(0, 200) + (text.length > 200 ? '...' : ''),
    language_boost,
    voice_id: voiceId,
    emotion,
    GroupId: config.minimaxGroupId
  };
  if (DEBUG_TTS) console.log('[MINIMAX-TTS] 送出請求 payload:', JSON.stringify(payload));

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.minimaxApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'speech-2.8-turbo',  // 2026-07-01 hd→turbo（取「活比較重要」）：inline 情緒逐句變化、發聲標籤原生解析，跟通話同款
      text,
      stream: false,
      language_boost,
      pronunciation_dict: { tone: PRONUNCIATION_DICT_TONE },
      voice_setting: {
        voice_id: voiceId,
        speed: settings.speed || 1.0,
        // 音量：至少 4.0（MiniMax vol 範圍 0~10、預設 1.0）；settings.volume 更大時才蓋過
        vol: Math.max(settings.volume || 0, 4.0),
        pitch: settings.pitch || 0,
        emotion
      },
      audio_setting: {
        sample_rate: 44100,   // 32000→44100：更飽滿、減少「飄/單薄」感
        bitrate: 128000,
        format: 'mp3',
        channel: 1
      },
      output_format: 'hex'
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Minimax TTS error:', errorText);
    throw new Error(`Minimax TTS error: ${response.status}`);
  }

  const data = await response.json() as {
    base_resp?: { status_code: number; status_msg: string };
    data?: { audio: string };
    extra_info?: { trace_id?: string };
  };

  if (data.base_resp?.status_code !== 0) {
    throw new Error(`Minimax TTS error: ${data.base_resp?.status_msg || 'unknown'}`);
  }
  if (data.extra_info?.trace_id) {
    if (DEBUG_TTS) console.log('[MINIMAX-TTS] 回應 trace_id:', data.extra_info.trace_id, '(可提供給 Minimax 支援查詢)');
  }
  const debugData = { payload: { ...payload, text_length: text.length }, traceId: data.extra_info?.trace_id, at: new Date().toISOString() };
  lastMinimaxDebug = debugData;
  // 寫入 DB 供多實例讀取（找兇手用）
  query(
    `INSERT INTO debug_tts_last_payload (id, payload, trace_id, at) VALUES (1, $1::jsonb, $2, $3)
     ON CONFLICT (id) DO UPDATE SET payload = EXCLUDED.payload, trace_id = EXCLUDED.trace_id, at = EXCLUDED.at`,
    [JSON.stringify(debugData.payload), debugData.traceId ?? null, debugData.at]
  ).catch((err) => { console.error('[MINIMAX-TTS] debug payload DB 寫入失敗:', err.message); });

  // 解碼 hex 格式音檔
  const hexString = data.data!.audio;
  const bytes = new Uint8Array(hexString.length / 2);
  for (let i = 0; i < hexString.length; i += 2) {
    bytes[i / 2] = parseInt(hexString.substring(i, i + 2), 16);
  }

  return bytes.buffer;
}

/**
 * 估算 MP3 音檔時長（毫秒）
 * 根據 bitrate 128kbps 和檔案大小估算
 * LINE audio message 需要真實 duration，寫死 10000ms 會導致播放異常
 */
function estimateAudioDuration(audioBuffer: ArrayBuffer): number {
  const bytes = audioBuffer.byteLength;
  if (bytes <= 0) return 1000; // 空檔案安全值
  // MP3 128kbps = 16000 bytes/sec
  const durationMs = Math.round((bytes / 16000) * 1000);
  // LINE 限制：至少 1 秒，最多 5 分鐘
  return Math.max(1000, Math.min(durationMs, 300000));
}

/**
 * 上傳音檔到 R2（帶驗證與重試）
 * 返回 { url, durationMs }
 */
export async function uploadToR2(audioBuffer: ArrayBuffer): Promise<{ url: string; durationMs: number }> {
  // === 0. 音檔有效性驗證 ===
  const durationMs = estimateAudioDuration(audioBuffer);

  if (audioBuffer.byteLength < 100) {
    console.error(`[mouth] ❌ 音檔太小 (${audioBuffer.byteLength} bytes)，跳過上傳`);
    throw new Error(`Audio buffer too small: ${audioBuffer.byteLength} bytes`);
  }

  // 檢查 MP3 header（前 2 bytes 應為 0xFF 0xFB/0xF3/0xF2 或 ID3 tag）
  const header = new Uint8Array(audioBuffer.slice(0, 3));
  const isMP3 = (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0) ||
    (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33); // ID3
  if (!isMP3) {
    console.warn(`[mouth] ⚠️ 音檔 header 不像 MP3: [${header[0]?.toString(16)}, ${header[1]?.toString(16)}, ${header[2]?.toString(16)}]`);
  }

  if (DEBUG_TTS) console.log(`[mouth] 音檔 size=${audioBuffer.byteLength} bytes, est. duration=${durationMs}ms`);

  const filename = `voice/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`;

  // === 1. PRIMARY：透過 Gateway Worker R2 binding 上傳（永不過期）===
  // Worker 有 native R2 binding，不需要 CF_API_TOKEN
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const workerResp = await fetch(
        `${config.gatewayWorkerUrl}/api/r2/upload?key=${filename}`,
        {
          method: 'PUT',
          headers: {
            'Content-Type': 'audio/mpeg',
            'X-Upload-Token': config.gatewayAuthToken
          },
          body: audioBuffer
        }
      );

      if (workerResp.ok) {
        const publicUrl = `${config.r2PublicUrl}/${filename}`;

        // 驗證 URL 可訪問（帶重試，確保 CDN 已 propagate）
        // LINE 收到 URL 後會立刻下載，如果 CDN 還沒準備好就會播放失敗
        let urlVerified = false;
        for (let verifyAttempt = 1; verifyAttempt <= 3; verifyAttempt++) {
          try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const checkResp = await fetch(publicUrl, {
              method: 'HEAD',
              signal: controller.signal
            });
            clearTimeout(timeout);
            if (checkResp.ok) {
              urlVerified = true;
              break;
            }
            console.warn(`[mouth] R2 URL 驗證第 ${verifyAttempt} 次: HTTP ${checkResp.status}`);
          } catch {
            console.warn(`[mouth] R2 URL 驗證第 ${verifyAttempt} 次超時`);
          }
          // 等待 CDN propagate（500ms → 1000ms → 不再等）
          if (verifyAttempt < 3) {
            await new Promise(r => setTimeout(r, verifyAttempt * 500));
          }
        }
        if (!urlVerified) {
          console.warn(`[mouth] ⚠️ R2 URL 3 次驗證都失敗，仍然使用（CDN 可能需要更長時間）`);
        }

        return { url: publicUrl, durationMs };
      }
      console.warn(`[mouth] Gateway Worker R2 upload attempt ${attempt} failed (${workerResp.status})`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
    } catch (err: any) {
      console.warn(`[mouth] Gateway Worker R2 error attempt ${attempt}: ${err.message}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 500));
    }
  }

  // === 2. FALLBACK：Cloudflare R2 REST API（需要 CF_API_TOKEN，可能過期）===
  if (config.cfApiToken && config.cfApiToken !== 'not-configured') {
    console.log(`[mouth] Gateway Worker 失敗，嘗試 CF REST API fallback...`);
    try {
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${config.cfAccountId}/r2/buckets/${config.r2Bucket}/objects/${filename}`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${config.cfApiToken}`,
            'Content-Type': 'audio/mpeg'
          },
          body: audioBuffer
        }
      );
      if (response.ok) {
        const publicUrl = `${config.r2PublicUrl}/${filename}`;
        console.log(`[mouth] ✅ R2 上傳成功（via CF REST API fallback）: ${publicUrl}`);
        return { url: publicUrl, durationMs };
      }
      console.warn(`[mouth] CF REST API fallback failed (${response.status})`);
    } catch (err: any) {
      console.warn(`[mouth] CF REST API fallback error: ${err.message}`);
    }
  }

  // === 3. 最終 Fallback：本地儲存（Railway 重部署後會消失） ===
  console.warn(`[mouth] ⚠️ R2 全部失敗，最終 fallback 到本地存儲`);
  const fs = await import('fs');
  const path = await import('path');
  const localDir = path.join(process.cwd(), 'public', 'voice');
  fs.mkdirSync(localDir, { recursive: true });
  const localFilename = `${Date.now()}_${Math.random().toString(36).substr(2, 9)}.mp3`;
  const localPath = path.join(localDir, localFilename);
  fs.writeFileSync(localPath, Buffer.from(audioBuffer));

  const baseUrl = process.env.RAILWAY_PUBLIC_DOMAIN
    ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}`
    : 'https://{{PUBLIC_DOMAIN}}';
  return { url: `${baseUrl}/voice/${localFilename}`, durationMs };
}
