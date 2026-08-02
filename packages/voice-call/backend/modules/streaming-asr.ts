/**
 * 🎤 Streaming ASR — Deepgram Nova-2 即時語音辨識
 *
 * 取代 Whisper 批次模式，音訊 chunk 即時串流到 Deepgram，
 * 200-300ms 就有 interim results，endpointing 自動偵測用戶停止說話。
 *
 * 核心優勢：
 * - 不需要 800ms VAD 等待
 * - 不需要整段音訊上傳
 * - interim results 可用於打斷偵測（barge-in）+ 狀態廣播
 * - endpointing 比我們自己的 RMS VAD 更準
 */

import WebSocket from 'ws';
import { config } from '../config.js';
import { SOUL } from './soulConfig.js';

// ============ 型別 ============

/** Deepgram 回傳的 transcript 附加資訊（用於背景音過濾） */
export interface TranscriptMeta {
  /** Deepgram 信心分數 0-1（背景音/遠場語音通常 < 0.5） */
  confidence: number;
  /** 此段 transcript 的字數 */
  wordCount: number;
}

export interface StreamingASRCallbacks {
  /** 收到中間結果（可能會改變） */
  onInterimTranscript: (text: string, meta: TranscriptMeta) => void;
  /** 收到最終結果（一句話確定了） */
  onFinalTranscript: (text: string, meta: TranscriptMeta) => void;
  /** 偵測到用戶停止說話 */
  onUtteranceEnd: () => void;
  /** 錯誤 */
  onError: (error: string) => void;
}

/**
 * 2026-06-19 N3 per-user endpointing tuning
 * 不同人說話節奏不一樣 — 有人快/破碎、有人慢/有停頓、有人偏連貫
 * 這些值可從 organ_settings.ear.settings 載入；未提供時走預設（保留原 W2.2 寬鬆值）
 */
export interface StreamingASRConfig {
  /** Deepgram endpointing 毫秒（越短越快切句、可能切到一半；越長越穩、但對方等更久）— 預設 500 */
  endpointingMs?: number;
  /** Deepgram utterance_end_ms（一整段話確定結束的閾值）— 預設 1200 */
  utteranceEndMs?: number;
}

interface DeepgramMessage {
  type: string;
  channel?: {
    alternatives: Array<{
      transcript: string;
      confidence: number;
    }>;
  };
  is_final?: boolean;
  speech_final?: boolean;
}

// ============ Streaming ASR 類 ============

export class StreamingASR {
  private ws: WebSocket | null = null;
  private callbacks: StreamingASRCallbacks;
  private isConnected = false;
  private pendingAudio: Buffer[] = [];
  private closed = false;

  // 累積的最終文字（一通電話裡可能有多句 final）
  private accumulatedFinal = '';

  // 🔧 BGFilter: 累積 confidence（多段 final 取加權平均）
  private accumulatedConfidenceSum = 0;
  private accumulatedCharCount = 0;

  // 自動重連
  private reconnectAttempts = 0;
  private static readonly MAX_RECONNECT = 5;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // 🔧 Keep-alive — 防止 Deepgram idle 1011 斷線（timeout ~10s）
  // 使用官方 KeepAlive JSON text frame（不是靜音 PCM）
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null;
  private lastAudioTime = Date.now();
  private static readonly KEEP_ALIVE_INTERVAL = 5000; // 5 秒檢查一次
  private static readonly SILENCE_THRESHOLD = 1000;   // 1 秒無音訊 → 送 KeepAlive

  // 2026-06-19 N3：per-user endpointing config
  private endpointingMs: number;
  private utteranceEndMs: number;

  constructor(callbacks: StreamingASRCallbacks, cfg: StreamingASRConfig = {}) {
    this.callbacks = callbacks;
    this.endpointingMs = cfg.endpointingMs ?? 500;
    this.utteranceEndMs = cfg.utteranceEndMs ?? 1200;
    this.connect();
  }

  /**
   * 建立 Deepgram WebSocket 連線
   */
  private connect(): void {
    const params = new URLSearchParams({
      model: 'nova-3',                  // 2026-06-18 升 nova-2 → nova-3（更新模型，中文準確度更好）
      language: 'zh-TW',
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      // 2026-06-18 W2.2 + 2026-06-19 N3：per-user 可調（預設保留寬鬆值）
      utterance_end_ms: String(this.utteranceEndMs),
      endpointing: String(this.endpointingMs),
      smart_format: 'true',
      punctuate: 'true',
    });

    // Deepgram keyterm bias（官方 sweet spot 20-30；過載反增 false positive）。
    // 靈殼：要 bias 的專有名詞為靈魂槽位，此處只保留人格自稱 + 技術詞，
    //       其餘常見人名交給 post-process 人名糾錯（modules/name-normalizer.ts）。
    const KEYTERMS = [
      // 人格自稱
      SOUL.name,
      // 技術詞 — 避免被當人名亂猜
      'LINE',
    ];
    for (const kt of KEYTERMS) {
      params.append('keyterm', kt);
    }

    const wsUrl = `wss://api.deepgram.com/v1/listen?${params.toString()}`;

    this.ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Token ${config.deepgramApiKey}`,
      },
    });

    this.ws.on('open', () => {
      console.log(`[Deepgram] WebSocket 連線建立${this.reconnectAttempts > 0 ? ` (重連 #${this.reconnectAttempts})` : ''}`);
      this.isConnected = true;
      this.accumulatedFinal = ''; // 🔧 Fix M4: 重連後清空累積文字，避免跨連線拼接
      this.accumulatedConfidenceSum = 0; // 🔧 BGFilter: 重連後重置 confidence
      this.accumulatedCharCount = 0;
      this.reconnectAttempts = 0; // 連線成功 → 重設重連計數
      this.lastAudioTime = Date.now();

      // 🔧 Log-fix Bug5: 啟動 keep-alive 計時器
      this.startKeepAlive();

      // 發送等待中的音訊
      for (const chunk of this.pendingAudio) {
        this.ws?.send(chunk);
      }
      this.pendingAudio = [];
    });

    this.ws.on('message', (rawData) => {
      if (this.closed) return;

      try {
        const msg: DeepgramMessage = JSON.parse(rawData.toString());

        if (msg.type === 'Results' && msg.channel?.alternatives?.[0]) {
          const alt = msg.channel.alternatives[0];
          const transcript = alt.transcript;
          const confidence = alt.confidence ?? 0;

          if (!transcript) return;

          if (msg.is_final) {
            // 最終結果（這一段話確定了）
            this.accumulatedFinal += transcript;
            // 🔧 BGFilter: 加權累積 confidence（按字數加權）
            const charLen = transcript.length;
            this.accumulatedConfidenceSum += confidence * charLen;
            this.accumulatedCharCount += charLen;

            if (msg.speech_final) {
              // speech_final = 用戶停止說話（endpointing 觸發）
              const finalText = this.accumulatedFinal.trim();
              const avgConf = this.accumulatedCharCount > 0
                ? this.accumulatedConfidenceSum / this.accumulatedCharCount
                : confidence;
              const meta: TranscriptMeta = {
                confidence: avgConf,
                wordCount: finalText.length,
              };
              this.callbacks.onFinalTranscript(finalText, meta);
              this.accumulatedFinal = '';
              this.accumulatedConfidenceSum = 0;
              this.accumulatedCharCount = 0;
            }
          } else {
            // 中間結果（可能會改變）
            const fullInterim = this.accumulatedFinal + transcript;
            const meta: TranscriptMeta = { confidence, wordCount: fullInterim.trim().length };
            this.callbacks.onInterimTranscript(fullInterim.trim(), meta);
          }
        }

        if (msg.type === 'UtteranceEnd') {
          // Deepgram 偵測到一段話結束
          if (this.accumulatedFinal.trim()) {
            const finalText = this.accumulatedFinal.trim();
            const avgConf = this.accumulatedCharCount > 0
              ? this.accumulatedConfidenceSum / this.accumulatedCharCount
              : 0.5; // UtteranceEnd 沒有新的 confidence → 用累積的或預設 0.5
            const meta: TranscriptMeta = {
              confidence: avgConf,
              wordCount: finalText.length,
            };
            this.callbacks.onFinalTranscript(finalText, meta);
            this.accumulatedFinal = '';
            this.accumulatedConfidenceSum = 0;
            this.accumulatedCharCount = 0;
          }
          this.callbacks.onUtteranceEnd();
        }
      } catch (err) {
        console.error('[Deepgram] 訊息解析錯誤:', err);
      }
    });

    this.ws.on('error', (err) => {
      console.error('[Deepgram] WebSocket 錯誤:', err.message);
      if (!this.closed) {
        this.callbacks.onError(`Deepgram 連線錯誤: ${err.message}`);
      }
    });

    this.ws.on('close', (code) => {
      console.log(`[Deepgram] WebSocket 關閉 (code=${code})`);
      this.isConnected = false;
      this.ws = null;
      this.stopKeepAlive(); // 🔧 Log-fix Bug5: 連線斷開時停止 keep-alive

      // 自動重連（除非主動關閉）
      if (!this.closed && this.reconnectAttempts < StreamingASR.MAX_RECONNECT) {
        this.reconnectAttempts++;
        const delay = Math.min(500 * Math.pow(2, this.reconnectAttempts - 1), 5000); // 500ms, 1s, 2s, 4s, 5s
        console.log(`[Deepgram] 自動重連 #${this.reconnectAttempts}/${StreamingASR.MAX_RECONNECT} (${delay}ms 後)`);
        this.reconnectTimer = setTimeout(() => {
          if (!this.closed) {
            this.connect();
          }
        }, delay);
      } else if (!this.closed) {
        console.error(`[Deepgram] 已達最大重連次數 (${StreamingASR.MAX_RECONNECT})，放棄`);
        this.callbacks.onError('Deepgram 連線中斷且無法重連');
      }
    });
  }

  /**
   * 餵音訊（PCM 16kHz mono 16-bit）
   */
  feedAudio(pcmChunk: Buffer): void {
    if (this.closed) return;
    this.lastAudioTime = Date.now(); // 🔧 Log-fix Bug5: 追蹤最後音訊時間

    if (this.isConnected && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(pcmChunk);
    } else {
      // 連線還沒好，先暫存
      this.pendingAudio.push(pcmChunk);
    }
  }

  /**
   * Keep-alive — 定期送 Deepgram 官方 KeepAlive JSON text frame
   * Deepgram idle timeout ~10 秒，每 5 秒檢查、1 秒無音訊就送
   * 必須是 text frame（ws.send(string) 預設就是 text）
   */
  private startKeepAlive(): void {
    this.stopKeepAlive();
    this.keepAliveTimer = setInterval(() => {
      if (!this.isConnected || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

      const silenceMs = Date.now() - this.lastAudioTime;
      if (silenceMs >= StreamingASR.SILENCE_THRESHOLD) {
        // 送 Deepgram 官方 KeepAlive（JSON text frame，非 binary）
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, StreamingASR.KEEP_ALIVE_INTERVAL);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) {
      clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  /**
   * 關閉連線
   */
  close(): void {
    this.closed = true;
    this.pendingAudio = [];
    this.stopKeepAlive(); // 🔧 Log-fix Bug5

    // 清除重連計時器
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      // 發送 close 信號（告訴 Deepgram 沒有更多音訊了）
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'CloseStream' }));
      }
      this.ws.close();
      this.ws = null;
    }
  }
}

/**
 * 檢查 Deepgram 是否可用
 */
export function isStreamingASRAvailable(): boolean {
  return config.deepgramApiKey !== 'not-configured';
}
