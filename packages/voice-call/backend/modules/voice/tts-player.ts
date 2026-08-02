/**
 * 🔊 TTSPlayer — 統一的 TTS 句子佇列播放器
 *
 * 從 voice-pipeline.ts (1745 行肥檔) 抽出來的獨立 module — P1 第一個 extraction
 * 2026-06-17 重構：邏輯不動，純拆檔
 *
 * 取代原本 processTTSQueue / processSpeculativeTTSQueue 兩份重複邏輯
 *
 * 用法：
 *   player.enqueue('你好')       → 加入佇列，自動開始播放
 *   player.markBrainDone()       → 告知 brain 已完成，佇列清空時觸發 onAllDone
 *   player.abort()               → 停止一切，觸發 onAllDone
 *   player.isIdle                → 沒有在播也沒有佇列
 */

import { config } from '../../config.js';
import { processEmotionTags } from '../mouth.js';

// TTS 模組：依 config.ttsMode 動態切換
// 'http' = 穩定版 HTTP Streaming（預設）
// 'ws'   = 舊版 WebSocket 連線池
const ttsModule = config.ttsMode === 'http'
  ? await import('../minimax-tts.js')
  : await import('../minimax-realtime.js');
const { streamTTS } = ttsModule;

export interface ActiveTTSStream {
  abort: () => void;
}

export class TTSPlayer {
  private queue: string[] = [];
  private activeTTS: ActiveTTSStream | null = null;
  private playing = false;
  private brainDone = false;
  private _aborted = false;
  /** TTS 全敗 fallback 計數（每個 player 生命週期最多觸發 1 次，避免無限迴圈） */
  private fallbackUsed = false;
  /** 🔧 重試時是否已送過 filler（每個句子最多一次，避免連續送） */
  private retryFillerSent = false;

  /** 🔇 P3 fix: filler 全域節流 — 5 秒內最多送 1 個，避免 TTS 連續失敗時 filler 洗版 */
  private static lastFillerTime = 0;
  private static readonly FILLER_COOLDOWN_MS = 5000;

  /** 全部播完（或被打斷）時觸發。aborted=true 表示是被 abort() 停掉而非自然播完 */
  onAllDone: ((info: { aborted: boolean }) => void) | null = null;
  /** 送音訊給前端 */
  private sendAudio: (chunk: Buffer) => void;
  /** 是否允許送音訊（投機模式可被隨時取消） */
  private canSend: () => boolean;
  /** 🔧 送 JSON 給前端（用於 TTS 重試時送 filler） */
  private sendJson: ((msg: Record<string, unknown>) => void) | null = null;

  constructor(sendAudio: (chunk: Buffer) => void, canSend?: () => boolean, sendJson?: (msg: Record<string, unknown>) => void) {
    this.sendAudio = sendAudio;
    this.canSend = canSend || (() => true);
    this.sendJson = sendJson || null;
  }

  /** 加入句子到佇列並開始播放 */
  enqueue(sentence: string): void {
    if (this._aborted) return;
    this.queue.push(sentence);
    this.processNext();
  }

  /** 標記 brain 已完成生成（佇列清空時將觸發 onAllDone） */
  markBrainDone(): void {
    this.brainDone = true;
    // 如果佇列已經空了，立刻觸發
    if (!this.playing && this.queue.length === 0) {
      this.fireAllDone();
    }
  }

  /** 靜音：立刻切斷音訊輸出，但不中止 TTS stream（讓它自然結束或延後 abort）
   *  用途：軟著陸打斷時先 mute()，300ms 後再 abort()，防止 300ms 間隙內新舊 player 同時送音訊 */
  mute(): void {
    this.canSend = () => false;  // 立刻停止送音訊給前端
    this.sendJson = null;        // 也停止送 filler JSON
  }

  /** 停止播放，清空佇列（保證觸發 onAllDone，帶 aborted: true） */
  abort(): void {
    if (this._aborted) return; // 冪等：避免重複 abort 觸發兩次 onAllDone
    this._aborted = true;
    this.queue = [];
    if (this.activeTTS) {
      this.activeTTS.abort();
      this.activeTTS = null;
    }
    this.playing = false;
    this.fireAllDone(true);
  }

  /** 是否完全閒置（沒有在播也沒有佇列） */
  get isIdle(): boolean {
    return !this.playing && this.queue.length === 0;
  }

  get isAborted(): boolean { return this._aborted; }
  get isPlaying(): boolean { return this.playing; }
  get queueLength(): number { return this.queue.length; }

  private fireAllDone(aborted = false): void {
    if (this.onAllDone) {
      const cb = this.onAllDone;
      this.onAllDone = null; // 只觸發一次
      cb({ aborted });
    }
  }

  private processNext(): void {
    if (this._aborted || this.playing || this.queue.length === 0) return;

    const raw = this.queue.shift()!;
    const sentence = processEmotionTags(raw);

    // 整句都是情緒標籤 → 跳過
    if (!sentence.trim()) {
      if (this.queue.length > 0) {
        this.processNext();
      } else if (this.brainDone) {
        this.fireAllDone();
      }
      return;
    }

    this.playing = true;
    // 🔧 每個句子重置 filler 旗標（避免同一句重試多次只送一次 filler）
    this.retryFillerSent = false;

    this.activeTTS = streamTTS({
      text: sentence,
      onAudioChunk: (chunk) => {
        if (!this._aborted && this.canSend()) {
          this.sendAudio(chunk);
        }
      },
      onDone: () => {
        this.activeTTS = null;
        this.playing = false;
        if (this._aborted) return;

        if (this.queue.length > 0) {
          this.processNext();
        } else if (this.brainDone) {
          this.fireAllDone();
        }
      },
      onError: (error) => {
        console.error('[TTSPlayer] TTS 錯誤:', error);
        this.activeTTS = null;
        this.playing = false;
        if (this._aborted) return;

        // 🔧 熔斷中：MiniMax 連續失敗，不嘗試 fallback（也會失敗），直接跳過所有佇列
        if (error === 'TTS_CIRCUIT_OPEN') {
          console.warn(`[TTSPlayer] ⏭️ TTS 熔斷中，跳過剩餘 ${this.queue.length} 句佇列`);
          this.queue = []; // 清空佇列，避免每句都等 → 快速結束
          if (this.brainDone) {
            this.fireAllDone();
          }
          // brain 未完成 → 等 markBrainDone() 呼叫後再 fireAllDone
          return;
        }

        // 🔧 TTS 全敗 fallback：用 filler 音檔替代（不再用 TTS 合成文字）
        // 直接送 filler 給前端，更自然、更快、不受 MiniMax 狀態影響
        if (error === 'TTS_ZERO_CHUNKS' && !this.fallbackUsed) {
          this.fallbackUsed = true;
          console.log('[TTSPlayer] 🔄 TTS 全敗，送 filler 替代（不再合成「等我一下」）');
          // 送 filler index 0（嗯）給前端播放 — 有 5 秒節流，避免連續 TTS 失敗時 filler 洗版
          const now = Date.now();
          if (this.sendJson && now - TTSPlayer.lastFillerTime >= TTSPlayer.FILLER_COOLDOWN_MS) {
            TTSPlayer.lastFillerTime = now;
            this.sendJson({ type: 'filler', index: 0 });
          }
          // 不再用 TTS 合成 fallback 文字，直接跳過失敗句子繼續
          this.playing = false;
          if (this._aborted) return;
          if (this.queue.length > 0) {
            this.processNext();
          } else if (this.brainDone) {
            this.fireAllDone();
          }
          return;
        }

        // ❌ 移除舊的 TTS fallback（下方是保留的 TTS_CIRCUIT_OPEN 處理）
        // 舊版會嘗試 TTS 合成「嗯...等我一下。」，但：
        // 1. MiniMax 風暴期間 fallback 本身也常失敗
        // 2. 用戶反饋這句話太刻意、不自然
        // 3. 現在改用 filler 音檔，0ms 延遲、100% 成功率

        // 以下是不應觸達的分支（fallbackUsed=true 後再次 TTS 全敗）
        if (error === 'TTS_ZERO_CHUNKS' && this.fallbackUsed) {
          console.warn('[TTSPlayer] ⏭️ TTS 再次全敗，跳過此句');
          this.playing = false;
          if (this._aborted) return;
          if (this.queue.length > 0) {
            this.processNext();
          } else if (this.brainDone) {
            this.fireAllDone();
          }
          return;
        }

        // 其他錯誤或 fallback 已用過 → 繼續下一句（不整個停掉）
        if (this.queue.length > 0) {
          this.processNext();
        } else if (this.brainDone) {
          this.fireAllDone();
        }
      },
      // 🔧 TTS 重試時送 filler 填補靜默（每個句子最多一次 + 全域 5 秒節流）
      onRetry: (attempt, maxRetries) => {
        if (this._aborted || this.retryFillerSent) return;
        this.retryFillerSent = true;
        const now = Date.now();
        if (this.sendJson && now - TTSPlayer.lastFillerTime >= TTSPlayer.FILLER_COOLDOWN_MS) {
          TTSPlayer.lastFillerTime = now;
          console.log(`[TTSPlayer] 🔊 TTS 重試中 (${attempt}/${maxRetries})，送 filler 填補靜默`);
          this.sendJson({ type: 'filler', index: 3 }); // index 3 = 唔... 思考中
        }
      },
    });
  }
}
