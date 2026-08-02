/**
 * 🔊 MiniMax HTTP Streaming TTS — 穩定版語音合成 v2
 *
 * 取代 minimax-realtime.ts（WebSocket 連線 1.5s 後斷線問題）
 * 改用 HTTP Streaming API：每個句子一個獨立 HTTP 請求
 * - HTTP Keep-Alive 連線複用（省 ~100ms/句 TCP+TLS handshake）
 * - PCM 格式輸出（省伺服器 MP3 編碼 + 前端解碼，共省 ~300-500ms）
 * - AbortController 取代 taskGeneration 計數器
 * - SSE 串流回傳音訊 chunk（hex encoded PCM）
 *
 * 匯出介面與 minimax-realtime.ts 完全相同，可直接替換
 */

import { config } from '../config.js';
import { logLLMCost } from './costMonitor.js';
import { detectEmotion, PRONUNCIATION_DICT_TONE } from './mouth.js';
import { Agent } from 'undici';
import * as OpenCC from 'opencc-js';

// 繁→簡（MiniMax 用簡體發音更準）
const twToSp = OpenCC.Converter({ from: 'tw', to: 'cn' });

// HTTP Keep-Alive 連線池（複用 TCP+TLS，省 ~100ms/句）
const keepAliveAgent = new Agent({
  keepAliveTimeout: 30_000,     // 連線閒置 30s 後關閉
  keepAliveMaxTimeout: 60_000,  // 最長保持 60s
  connections: 8,               // 最多 8 條並行連線（多人同時通話需要更多）
});

// ============ 熔斷器（Circuit Breaker）v2 — 時間窗口版 ============
//
// v1 問題：「連續失敗」計數被偶發成功重置 → MiniMax 風暴期間永遠觸不到門檻
// v2 改用：時間窗口內的失敗率（30s 內失敗 5 次 → 熔斷）
//   - recordSuccess 不再重置失敗計數，只記錄到時間窗口
//   - 時間窗口自動滑動，舊的記錄自動過期
//
// 狀態機：CLOSED (正常) → OPEN (熔斷) → HALF_OPEN (試探) → CLOSED
//
const circuitBreaker = {
  /** 時間窗口內的失敗時間戳 */
  failureTimestamps: [] as number[],
  /** 時間窗口內的成功時間戳 */
  successTimestamps: [] as number[],
  /** 熔斷狀態 */
  isOpen: false,
  /** 熔斷開始時間 */
  openedAt: 0,
  /** 冷卻期（毫秒） */
  cooldownMs: 20_000, // 20 秒（讓 MiniMax 有更多恢復時間，0-chunks 爆發期可能持續 10-15 秒）
  /** 時間窗口（毫秒） */
  windowMs: 30_000, // 30 秒
  /** 窗口內失敗幾次觸發熔斷 */
  failureThreshold: 4, // 4 次（從 5 降低，更快進入熔斷保護）
  /** 半開模式 */
  halfOpen: false,

  /** 清理過期記錄 */
  _pruneWindow(): void {
    const cutoff = Date.now() - this.windowMs;
    this.failureTimestamps = this.failureTimestamps.filter(t => t > cutoff);
    this.successTimestamps = this.successTimestamps.filter(t => t > cutoff);
  },

  /** 記錄一次成功 */
  recordSuccess(): void {
    this.successTimestamps.push(Date.now());
    this._pruneWindow();
    if (this.halfOpen) {
      // 半開試探成功 → 恢復正常
      console.log(`[MiniMax-CB] ✅ 半開試探成功，恢復正常 (窗口內: ${this.failureTimestamps.length} 失敗 / ${this.successTimestamps.length} 成功)`);
      this.isOpen = false;
      this.halfOpen = false;
    } else if (this.failureTimestamps.length > 0) {
      console.log(`[MiniMax-CB] ✅ TTS 成功 (窗口內: ${this.failureTimestamps.length} 失敗 / ${this.successTimestamps.length} 成功)`);
    }
  },

  /** 記錄一次失敗 */
  recordFailure(): void {
    this.failureTimestamps.push(Date.now());
    this._pruneWindow();
    if (this.halfOpen) {
      // 半開試探失敗 → 重新熔斷
      this.isOpen = true;
      this.openedAt = Date.now();
      this.halfOpen = false;
      console.warn(`[MiniMax-CB] 🔴 半開試探失敗，重新熔斷 (${this.cooldownMs}ms)`);
      return;
    }
    if (this.failureTimestamps.length >= this.failureThreshold && !this.isOpen) {
      this.isOpen = true;
      this.openedAt = Date.now();
      console.warn(`[MiniMax-CB] 🔴 熔斷觸發！${this.windowMs / 1000}s 內 ${this.failureTimestamps.length} 次失敗，暫停 TTS ${this.cooldownMs}ms`);
    }
  },

  /** 檢查是否允許發送請求 */
  allowRequest(): boolean {
    if (!this.isOpen) return true;
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.halfOpen = true;
      this.isOpen = false;
      console.log(`[MiniMax-CB] 🟡 冷卻期結束，進入半開模式（試探一次）`);
      return true;
    }
    return false;
  },

  /** 取得熔斷狀態描述 */
  get status(): string {
    if (this.isOpen) return 'OPEN';
    if (this.halfOpen) return 'HALF_OPEN';
    return 'CLOSED';
  },

  /** 供外部查詢用：窗口內失敗次數 */
  get recentFailures(): number {
    this._pruneWindow();
    return this.failureTimestamps.length;
  },
};

/** 供外部查詢 TTS 健康狀態 */
export function getTTSHealth(): { status: string; recentFailures: number; isOpen: boolean } {
  return {
    status: circuitBreaker.status,
    recentFailures: circuitBreaker.recentFailures,
    isOpen: circuitBreaker.isOpen,
  };
}

// ============ 型別 ============

export interface MinimaxStreamOptions {
  /** 要合成的文字 */
  text: string;
  /** 語言（auto 自動偵測） */
  language?: 'zh' | 'en' | 'auto';
  /** 每收到一段音訊的回調（PCM binary, 24kHz 16-bit mono LE） */
  onAudioChunk: (chunk: Buffer) => void;
  /** 全部音訊播完 */
  onDone: () => void;
  /** 錯誤 */
  onError: (error: string) => void;
  /** 🔧 重試時的回呼（讓 pipeline 送 filler 填補靜默） */
  onRetry?: (attempt: number, maxRetries: number) => void;
}

interface SSEChunk {
  data?: {
    audio?: string; // hex encoded
    status?: number; // 1 = audio, 2 = final metadata
  };
  trace_id?: string;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
  extra_info?: Record<string, unknown>;
}

// ============ HTTP Streaming TTS ============

/**
 * 用 MiniMax HTTP Streaming API 合成語音
 *
 * 回傳 abort function，呼叫可中斷當前合成（打斷機制）
 */
export function streamTTS(options: MinimaxStreamOptions): { abort: () => void } {
  const { text, language = 'auto', onAudioChunk, onDone, onError, onRetry } = options;

  const controller = new AbortController();
  let aborted = false;

  // 偵測語言
  const isEnglish = language === 'en' ||
    (language === 'auto' && isEnglishText(text));

  // 選聲紋
  const voiceId = isEnglish
    ? config.minimaxVoiceIdEn
    : config.minimaxVoiceIdZh;

  // 偵測情緒
  const emotion = detectEmotion(text);

  // 清洗 TTS 不友善的特殊字元（注音符號、全形括號動作等）
  const sanitized = sanitizeTTSText(text);

  // 清洗後如果是空字串 → 跳過
  if (!sanitized.trim()) {
    onDone();
    return { abort: () => {} };
  }

  // 繁→簡（中文才轉）
  const processedText = isEnglish ? sanitized : twToSp(sanitized);

  // 語言提升
  const languageBoost = isEnglish ? 'English' : 'Chinese';

  console.log(`[MiniMax-HTTP] TTS: voice=${voiceId.slice(-8)} emotion=${emotion} lang=${languageBoost} text="${processedText.slice(0, 30)}"`);

  // 🔧 熔斷器檢查：MiniMax 連續失敗時快速跳過，避免浪費 5s/句的重試等待
  if (!circuitBreaker.allowRequest()) {
    console.warn(`[MiniMax-HTTP] ⏭️ 熔斷中，跳過 TTS: "${text.slice(0, 30)}" (窗口內 ${circuitBreaker.recentFailures} 次失敗)`);
    // 直接報錯 → TTSPlayer 跳過這句繼續下一句
    onError('TTS_CIRCUIT_OPEN');
    return { abort: () => {} };
  }

  // 非同步執行 HTTP streaming（含自適應重試）
  // 0-chunks 通常在 ~200ms 內就能偵測到（MiniMax 快速返回空回應）
  // 策略：首次重試幾乎不等（100ms），後續逐步加長
  const MAX_RETRIES = circuitBreaker.halfOpen ? 0 : 2; // 半開模式不重試；正常 2 次（從 3 降低，減少無效等待）

  // 🔧 自適應重試延遲：根據錯誤類型調整
  // 0-chunks 爆發期通常持續數秒，短間隔重試往往全敗
  // 加寬間隔讓 MiniMax 有恢復時間
  const getRetryDelay = (attempt: number, err: string): number => {
    if (err === 'TTS_ZERO_CHUNKS') {
      return [300, 1200][attempt] || 1200; // 加寬重試：300ms → 1.2s（從 100/400/1000 調整）
    }
    return [500, 2000][attempt] || 2000; // 服務端錯誤：較長退避
  };

  const doTTSWithRetry = async (attempt: number) => {
    try {
      await doStreamTTS({
        text: processedText,
        voiceId,
        emotion,
        languageBoost,
        signal: controller.signal,
        onAudioChunk: (chunk) => {
          if (!aborted) onAudioChunk(chunk);
        },
        onDone: () => {
          if (!aborted) {
            circuitBreaker.recordSuccess();
            onDone();
          }
        },
        onError: async (err) => {
          if (aborted) return;
          // 可重試的錯誤：0 chunks、[1000] unknown、429 rate limit、5xx、fetch failed
          const isRetryable = err === 'TTS_ZERO_CHUNKS'
            || err.includes('[1000]')
            || err.includes('429')
            || err.includes('500')
            || err.includes('502')
            || err.includes('503')
            || err.includes('fetch failed');
          if (isRetryable && attempt < MAX_RETRIES) {
            const delay = getRetryDelay(attempt, err);
            console.log(`[MiniMax-HTTP] 🔄 重試 TTS (attempt ${attempt + 1}/${MAX_RETRIES}, ${delay}ms 後): "${text.slice(0, 30)}"`);
            // 🔧 通知 pipeline 正在重試 → 可送 filler 填補靜默
            if (onRetry) onRetry(attempt + 1, MAX_RETRIES);
            await new Promise(r => setTimeout(r, delay));
            if (!aborted) await doTTSWithRetry(attempt + 1);
          } else {
            // 所有重試都失敗了 → 記錄到熔斷器
            circuitBreaker.recordFailure();
            onError(err);
          }
        },
      });
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      if (!aborted) onError(`MiniMax HTTP TTS 錯誤: ${err.message}`);
    }
  };

  doTTSWithRetry(0);

  return {
    abort: () => {
      aborted = true;
      controller.abort();
    },
  };
}

/**
 * 關閉 keep-alive 連線池
 */
export function closePooledConnection(): void {
  keepAliveAgent.close();
}

// ============ 核心：HTTP SSE Streaming ============

interface DoStreamTTSParams {
  text: string;
  voiceId: string;
  emotion: string;
  languageBoost: string;
  signal: AbortSignal;
  onAudioChunk: (chunk: Buffer) => void;
  onDone: () => void;
  onError: (error: string) => void;
}

async function doStreamTTS(params: DoStreamTTSParams): Promise<void> {
  const { text, voiceId, emotion, languageBoost, signal, onAudioChunk, onDone, onError } = params;

  const url = `https://api.minimax.io/v1/t2a_v2${config.minimaxGroupIdQuery}`;

  const body = {
    model: 'speech-2.8-turbo',  // 2026-06-12 升級 02 → 2.8（最新 SOTA，含 inline emotion tag native parsing）
    text,
    stream: true,
    language_boost: languageBoost,
    pronunciation_dict: { tone: PRONUNCIATION_DICT_TONE },
    voice_setting: {
      voice_id: voiceId,
      speed: 1.0,
      vol: 1.0,
      pitch: 0,
      emotion,
    },
    audio_setting: {
      sample_rate: 24000,
      bitrate: 128000,
      format: 'mp3',     // 暫時改回 MP3（PCM hex streaming 待驗證）
      channel: 1,
    },
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.minimaxApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
    // @ts-expect-error undici Agent vs undici-types Dispatcher 型別不完全相容
    dispatcher: keepAliveAgent,
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    console.error(`[MiniMax-HTTP] HTTP ${response.status}: ${errText.slice(0, 300)} | text="${text.slice(0, 50)}"`);
    // 回傳含狀態碼的錯誤，讓重試邏輯能判斷是否可重試
    onError(`MiniMax HTTP ${response.status}: ${errText.slice(0, 200)}`);
    return;
  }

  if (!response.body) {
    onError('MiniMax HTTP: response body 為空');
    return;
  }

  // 💰 奶粉錢·🎙️嗓子：MiniMax 計費在請求（200 即已計）。無即時帳單 API，用字數×估算費率。
  // MINIMAX_USD_PER_1K_CHARS 為估算值、校準後可改（見奶粉錢表會標「估」）。
  logLLMCost('voice', `minimax-${body.model}`, {}, undefined, { chars: text.length },
    (text.length / 1000) * 0.02);

  // 讀取 SSE 串流
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let chunkCount = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // SSE 事件以 \n\n 分隔
      const events = buffer.split('\n\n');
      buffer = events.pop()!; // 最後一段可能不完整，留在 buffer

      for (const event of events) {
        if (!event.trim()) continue;

        // 找到 data: 開頭的行
        const dataLine = event.split('\n').find(line => line.startsWith('data:'));
        if (!dataLine) continue;

        const jsonStr = dataLine.slice(5).trim(); // 去掉 "data:" 前綴
        if (!jsonStr) continue;

        try {
          const parsed: SSEChunk = JSON.parse(jsonStr);

          // 檢查錯誤
          if (parsed.base_resp && parsed.base_resp.status_code !== 0) {
            const errMsg = `MiniMax TTS 錯誤: [${parsed.base_resp.status_code}] ${parsed.base_resp.status_msg}`;
            console.error(`[MiniMax-HTTP] ${errMsg} | text="${text.slice(0, 50)}" | trace=${parsed.trace_id}`);
            onError(errMsg);
            reader.cancel();
            return;
          }

          // status 2 = 最終 metadata（不含音訊），跳過
          if (parsed.data?.status === 2) continue;

          // 音訊 chunk
          if (parsed.data?.audio) {
            const bytes = Buffer.from(parsed.data.audio, 'hex');
            if (bytes.length > 0) {
              chunkCount++;
              onAudioChunk(bytes);
            }
          }
        } catch (parseErr) {
          console.warn('[MiniMax-HTTP] SSE JSON 解析失敗:', jsonStr.slice(0, 100));
        }
      }
    }

    // 處理 buffer 中剩餘的資料
    if (buffer.trim()) {
      const dataLine = buffer.split('\n').find(line => line.startsWith('data:'));
      if (dataLine) {
        const jsonStr = dataLine.slice(5).trim();
        if (jsonStr) {
          try {
            const parsed: SSEChunk = JSON.parse(jsonStr);
            if (parsed.data?.audio && parsed.data?.status !== 2) {
              const bytes = Buffer.from(parsed.data.audio, 'hex');
              if (bytes.length > 0) {
                chunkCount++;
                onAudioChunk(bytes);
              }
            }
          } catch { /* 忽略不完整的最後一段 */ }
        }
      }
    }

    console.log(`[MiniMax-HTTP] TTS 完成: ${chunkCount} chunks | text="${text.slice(0, 30)}"`);

    // 0 chunks = MiniMax 沒生成音訊（偶發問題），回報為可重試錯誤
    if (chunkCount === 0) {
      console.warn(`[MiniMax-HTTP] ⚠️ 0 chunks! text="${text.slice(0, 50)}" — 可能需要重試`);
      onError('TTS_ZERO_CHUNKS');
      return;
    }

    onDone();

  } catch (err: any) {
    if (err?.name === 'AbortError') throw err; // 讓外層處理 abort
    onError(`MiniMax HTTP 串流錯誤: ${err.message}`);
  }
}

// ============ 工具 ============

/**
 * 清洗 TTS 不友善的特殊字元
 * MiniMax 遇到這些字元可能回傳 0 chunks（靜默失敗）
 */
// 2026-06-19 MiniMax 官方 19 個 native sound tags — 不可 strip、要 pass 給 API
const MINIMAX_SOUND_TAGS = new Set([
  'laughs', 'chuckle', 'coughs', 'clear-throat', 'groans',
  'breath', 'pant', 'inhale', 'exhale', 'gasps',
  'sniffs', 'sighs', 'snorts', 'burps', 'lip-smacking',
  'humming', 'hissing', 'emm', 'sneezes',
]);

function sanitizeTTSText(text: string): string {
  return text
    // 情緒自選標籤 [EMOTION:x]：detectEmotion 已讀過，這裡 strip 不讓念出來
    .replace(/\[EMOTION:[^\]]*\]/gi, '')
    // Markdown：**粗體**保留字（強調真實文字）、*斜體*整串刪（星號=舞台指示/語氣旁白，通話不念出來）
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '')
    // 移除注音符號（ㄅ-ㄩ + 聲調 ˊˇˋ˙）— STT/Claude 偶爾會輸出注音
    .replace(/[\u3105-\u3129\u02CA\u02C7\u02CB\u02D9]/g, '')
    // 全形括號動作描述（中文）— 全部 strip
    .replace(/（[^）]{1,10}）/g, '')
    // 2026-06-19 半形括號 — 保留 MiniMax 19 個 native sound tags、其他 strip
    .replace(/\(([^)]{1,15})\)/g, (_match, content: string) => {
      const normalized = (content as string).toLowerCase().trim();
      return MINIMAX_SOUND_TAGS.has(normalized) ? `(${content})` : '';
    })
    // 移除 emoji
    .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}]/gu, '')
    // 清理多餘空白
    .replace(/\s+/g, ' ')
    .trim();
}

function isEnglishText(text: string): boolean {
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalLetters = englishChars + chineseChars;
  if (totalLetters === 0) return false;
  return englishChars / totalLetters > 0.85;
}
