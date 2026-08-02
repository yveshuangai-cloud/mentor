/**
 * 🎙️ 語音通話 Pipeline v6 — 線性流程（已移除投機模式）
 *
 * 流程：
 * 1. 音訊 chunk 即時串流到 Deepgram
 * 2. Deepgram interim → 打斷偵測（barge-in）
 * 3. Deepgram final → Claude streaming brain
 * 4. token 累積成句 → MiniMax TTS → 前端
 *
 * 設計原則（2026-06-19 移除投機後）：
 * - 不在 interim 階段預跑 brain（避免「投機命中後重播」bug）
 * - interim 只服務於「打斷 AI」+「狀態廣播」
 * - 軟著陸打斷：fade-out 300ms 降音量再停
 * - Echo Gate：Deepgram transcript 比對 AI 說的字，過濾迴音
 * - Pipeline Phase：語義狀態追蹤（idle → processing → speaking → idle）
 * - 記憶碎片：背景搜尋舊記憶 + prompt 引導 Claude 自然提起
 *
 * Fallback：沒有 Deepgram key → 退回 Whisper batch 模式
 */

import { config } from '../config.js';
import { query } from '../db/index.js';
import { processMessage } from './brain.js';
import { streamVoiceBrain, isVoiceBrainAvailable, prefetchVoiceContext, generateCallSummary, generateInnerMonologue, type VoiceContext } from './voice-brain.js';
import { recordMonologue } from './innerMonologue.js';
import { shouldRespond } from './voice-judge.js';  // P0.2 dual-brain judge（VOICE_JUDGE_ENABLED=true 才啟用）
import { saveMemory, searchMemories } from './memory.js';
import { WHISPER_NAME_HINT } from './sttHints.js';
import { StreamingASR, isStreamingASRAvailable } from './streaming-asr.js';
import { normalizeNames } from './name-normalizer.js';
import type { VoiceSession } from './voice-session.js';
// P1 extraction (2026-06-17): TTSPlayer 搬到獨立 module（voice-pipeline 砍 ~210 行）
import { TTSPlayer } from './voice/tts-player.js';
// P1 extraction #2 (2026-06-17): BGFilter 三層背景音過濾搬到獨立 module
import {
  BG_CONFIDENCE_HARD_REJECT,
  BG_CONFIDENCE_CONTEXT_CHECK,
  isBackgroundNoise,
  isContextuallyIncoherent,
} from './voice/bg-filter.js';
// P1 extraction #3 (2026-06-17): Echo Filter — transcriptsMatch + isEcho + Levenshtein
import { transcriptsMatch, isEcho } from './voice/echo-filter.js';
// Re-export for back-compat（其他 module 可能 import { transcriptsMatch } from './voice-pipeline.js'）
export { transcriptsMatch };
// P1 extraction #4 (2026-06-17): voice utilities — TTS 前處理 + tech leak 偵測 + PCM→WAV
import { stripLeadingInterjection, containsTechLeak, pcmToWav } from './voice/utils.js';
// 👂 通話新耳朵（B 階段）：Gemini 聽非語言聲音場景（咳嗽/環境/說話者）
import { describeAudioScene } from './musicEar.js';
import { classifyYamnet } from './yamnet.js';
import { classifyAffect } from './affect.js';

// ============ 型別 ============

export interface VoicePipelineCallbacks {
  sendAudio: (data: Buffer) => void;
  sendJson: (msg: Record<string, unknown>) => void;
}

// ============ TTS 播放引擎已抽出 ============
// P1 extraction: TTSPlayer 類別現在在 ./voice/tts-player.ts
// 介面不變、行為不變、改善 1745 行肥檔可讀性

// ============ Pipeline 狀態 ============

/**
 * Pipeline 語義狀態（用於 debug + 斷言，不取代原本的 boolean）
 *
 *   IDLE → PROCESSING → SPEAKING → IDLE
 *                ↑          │
 *                └── interrupt ──┘
 *
 *   GREETING 是特殊狀態：播放開場白，禁止打斷
 */
type PipelinePhase = 'idle' | 'greeting' | 'processing' | 'speaking';

// ============ Pipeline Class ============

export class VoicePipeline {
  private session: VoiceSession;
  private callbacks: VoicePipelineCallbacks;

  // Streaming ASR（Deepgram）
  private streamingASR: StreamingASR | null = null;
  private _useStreamingASR: boolean;

  /** 是否正在使用 Streaming ASR（Deepgram），供外部檢查 */
  get hasStreamingASR(): boolean { return this._useStreamingASR; }

  // Whisper fallback 用的音訊緩衝
  private audioChunks: Buffer[] = [];
  private isCollecting = false;
  // 👂 通話聲音場景感知（B 階段）：streaming 模式下 Deepgram 直收音訊、本地不留；
  // 這裡 tee 一份 rolling 副本給 Gemini 分析非語言聲音。lastAudioScene 注入下一輪 prompt。
  private sceneAudioChunks: Buffer[] = [];
  private sceneAudioBytes = 0;
  private lastAudioScene?: string;
  private lastAudioSceneAt = 0;                          // 偵測到事件的時間（過期用）
  private lastSoundReactAt = 0;                          // 上次「主動驚呼」時間（debounce 用）
  private soundReactCount = 0;                           // 主動反應次數（用來換句、避免每次同一句）
  private lastArousal?: number;                          // 🫧 情緒底色：聲音活化度（低=累）
  private lastArousalAt = 0;
  private affectTick = 0;                                // 節流：affect 每 2 tick 才跑一次
  private sceneTimer?: ReturnType<typeof setInterval>;   // 定時掃描 rolling buffer（補覆蓋）

  // TTS 播放引擎
  private ttsPlayer: TTSPlayer | null = null;
  private brainAbortController: AbortController | null = null;

  // 對話歷史（上限 50 條，避免長通話記憶體膨脹）
  private static readonly MAX_HISTORY = 50;
  private conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  /** 推入對話歷史並自動修剪 */
  private pushHistory(entry: { role: 'user' | 'assistant'; content: string }): void {
    this.conversationHistory.push(entry);
    if (this.conversationHistory.length > VoicePipeline.MAX_HISTORY) {
      this.conversationHistory = this.conversationHistory.slice(-VoicePipeline.MAX_HISTORY);
    }
  }

  // 預取上下文
  private prefetchedContext: VoiceContext | null = null;

  // 打斷偵測
  private interruptedByTranscript = false;  // Deepgram 打斷旗標

  // Echo Gate：追蹤 AI 正在說的文字，用於過濾 Deepgram 迴音
  private recentSpokenText = '';  // AI 當前/最近說的文字（用於比對迴音）

  // 🛡️ Anti-Loop：連續重複偵測 + 速率限制（防止背景音無限迴圈）
  private recentFinals: { text: string; time: number }[] = [];
  private lastTurnEndTime = 0;

  // 🧠 自我察覺反射 task #1 Layer 1 — 上一輪的 meta 訊號，傳給下一輪讓人格自己看
  private lastTurnMeta: {
    sttConfidence?: number;
    firstSentenceMs?: number;
    wasInterrupted?: boolean;
    repeatedKeyword?: { word: string; count: number };
  } = {};
  private currentTurnFirstSentMs: number | null = null;
  private currentTurnSttConfidence: number | null = null;
  private currentTurnWasInterrupted = false;

  // W2.3 — agent.state 細分用：防 spam 廣播
  private _lastHearingBroadcast = 0;
  private static readonly DEDUP_WINDOW_MS = 15_000;     // 15 秒內相同文字視為重複
  private static readonly MIN_TURN_INTERVAL_MS = 2_000;  // 兩次回覆間最少 2 秒
  private static readonly MAX_SIMILAR_COUNT = 1;          // 同一句話在 15s 內只處理 1 次（防 Deepgram re-endpointing 重複）

  // 狀態（Phase = 語義狀態，boolean = 快速檢查）
  private _phase: PipelinePhase = 'idle';
  isSpeaking = false;
  private isGreeting = false; // 開場白播放中，禁止 Deepgram 打斷（避免迴音誤觸）
  private isProcessing = false; // 防止重複處理
  private pendingTranscript: string | null = null; // Fix 0C: 排隊而非丟棄
  private _streamingResolve: (() => void) | null = null; // QA-C3: 讓 interrupt() 能 resolve streamingThinkAndSpeak
  private _isDestroyed = false; // 🔒 QA-R2: destroy() 冪等保護
  private _finalized = false;   // 🔒 P0.3: saveCallSummary 冪等保護（借鏡 ailivex finalize lock）
  // 🎙️ 通話錄音：累積她的 TTS MP3 chunks，掛斷時接起來上 R2、掛進 call_summary
  private recordedAudio: Buffer[] = [];
  private recordedBytes = 0;
  private static readonly REC_CAP = 20 * 1024 * 1024; // 20MB 上限（~20min），防超長通話爆記憶體
  /** tee 一份她的通話語音 chunk 給錄音（不影響即時播放） */
  private recordCallAudio(chunk: Buffer): void {
    if (this.recordedBytes >= VoicePipeline.REC_CAP) return;
    this.recordedAudio.push(chunk);
    this.recordedBytes += chunk.length;
  }

  /** 切換 Phase（debug 用，記錄狀態轉換） */
  private setPhase(phase: PipelinePhase): void {
    if (this._phase !== phase) {
      console.log(`[VoicePipeline] 📍 ${this._phase} → ${phase} (${this.session?.userName || '?'})`);
      this._phase = phase;
    }
  }

  // 🚫 filler 系統已停用（lastTurnSentiment 不再使用）

  // 計時
  private speechEndTime = 0;

  constructor(session: VoiceSession, callbacks: VoicePipelineCallbacks) {
    this.session = session;
    this.callbacks = callbacks;
    this._useStreamingASR = isStreamingASRAvailable();

    // 預取上下文
    if (isVoiceBrainAvailable() && session.dbUserId) {
      prefetchVoiceContext({
        userId: session.dbUserId,
        lineUserId: session.userId,
        userName: session.userName,
      }).then(ctx => {
        this.prefetchedContext = ctx;
      }).catch(err => {
        console.warn('[VoicePipeline] 上下文預取失敗:', err.message);
      });
    }

    // 初始化 Deepgram streaming ASR
    if (this._useStreamingASR) {
      this.initStreamingASR();
      // 👂 聲音場景定時掃描（B 階段補覆蓋）：每 7s 掃 rolling buffer，
      // 抓住「講話空檔」的咳嗽/噴嚏等（單靠每句分析會漏掉空檔的聲音）。
      this.sceneTimer = setInterval(() => this.analyzeSceneTick(), 4000);
    }
  }

  // ============ Streaming ASR 初始化 ============

  /**
   * 2026-06-19 N3：載入 per-user endpointing config
   * organ_settings.ear.settings JSONB 可放 {endpointing_ms, utterance_end_ms}
   * 沒設定 → 用預設（500/1200，原 W2.2 寬鬆值）
   */
  private async loadEarConfig(): Promise<{ endpointingMs?: number; utteranceEndMs?: number }> {
    if (!this.session.dbUserId) return {};
    try {
      const r = await query<{ settings: any }>(
        `SELECT settings FROM organ_settings WHERE user_id = $1 AND organ_name = 'ear' LIMIT 1`,
        [this.session.dbUserId],
      );
      const s = r.rows[0]?.settings || {};
      return {
        endpointingMs: typeof s.endpointing_ms === 'number' ? s.endpointing_ms : undefined,
        utteranceEndMs: typeof s.utterance_end_ms === 'number' ? s.utterance_end_ms : undefined,
      };
    } catch { return {}; }
  }

  private async initStreamingASR(): Promise<void> {
    const earCfg = await this.loadEarConfig();
    if (earCfg.endpointingMs || earCfg.utteranceEndMs) {
      console.log(`[VoicePipeline] per-user ASR config user=${this.session.dbUserId}: endpointing=${earCfg.endpointingMs ?? '預設500'}ms utterance_end=${earCfg.utteranceEndMs ?? '預設1200'}ms`);
    }
    this.streamingASR = new StreamingASR({
      onInterimTranscript: (text, meta) => {
        // 🛡️ BGFilter Layer 1（interim）：低信心 → 不觸發打斷/投機
        if (meta.confidence < BG_CONFIDENCE_HARD_REJECT) {
          return; // 靜默忽略，不 log（interim 量很大）
        }

        // W2.3 — agent.state 細分 listening vs hearing
        // interim 進來 = 對方正在說話，前端可顯示「對方說話中...」
        // 防 spam：只在 idle 階段送，且 5s 內最多送 1 次
        if (this._phase === 'idle' && !this.isSpeaking) {
          const now = Date.now();
          if (now - this._lastHearingBroadcast > 5000) {
            this.callbacks.sendJson({ type: 'status', state: 'hearing' });
            this._lastHearingBroadcast = now;
          }
        }

        // === Deepgram 打斷偵測（含 Echo Gate）===
        if (this.isSpeaking && !this.isGreeting && text && text.length >= 4) {
          // Echo Gate：比對 Deepgram transcript 和 AI 正在說的文字
          // 如果 Deepgram 聽到的跟 AI 說的很像 → 是迴音，忽略
          if (this.recentSpokenText && isEcho(text, this.recentSpokenText)) {
            // 迴音，不打斷（靜默忽略，不 log 以免刷屏）
            return;
          }
          console.log(`[VoicePipeline] 🎤 Deepgram 偵測到打斷: "${text.slice(0, 30)}" (${this.session.userName})`);
          this.interruptedByTranscript = true;
          this.currentTurnWasInterrupted = true;  // 🧠 自我察覺：標記本輪有被打斷
          this.interrupt();
          // 🔧 Fix: 不再手動送 audio:done — interrupt() 的軟著陸會在 fade-out 後處理
          // interrupt() 結尾已送 status:listening，前端靠 audio:fadeout 啟動淡出
          return;
        }

        // 2026-06-19: 已移除「interim 穩定 → 投機 brain」邏輯
        // 原因：投機命中後重播 bug（TTS 已播完未確認時，final 到達會重新 enqueue）
        // 簡化後：interim 只負責打斷偵測 + 狀態廣播
      },

      onFinalTranscript: (rawText, meta) => {
        if (!rawText.trim()) return;

        // 🔤 2026-06-19 Climb 3 — STT 人名糾錯後處理（Deepgram 中文人名常認錯）
        // 人名糾錯：把 STT 常聽錯的變體正規化回正確人名（規則見 name-normalizer.ts）
        const { normalized, hits } = normalizeNames(rawText);
        const text = normalized;
        if (hits.length > 0) {
          console.log(`[NameNorm] 人名糾錯: ${hits.join(', ')} | "${rawText.slice(0, 40)}" → "${text.slice(0, 40)}"`);
        }

        // 🛡️ BGFilter Layer 1：低信心直接丟棄
        if (meta.confidence < BG_CONFIDENCE_HARD_REJECT) {
          console.warn(`[BGFilter] ❌ L1 信心過低: ${meta.confidence.toFixed(2)} "${text.slice(0, 40)}" (${this.session.userName})`);
          return;
        }

        // 🛡️ BGFilter Layer 2：背景音特徵偵測
        if (isBackgroundNoise(text, meta.confidence)) {
          console.warn(`[BGFilter] ❌ L2 背景音特徵: conf=${meta.confidence.toFixed(2)} "${text.slice(0, 40)}" (${this.session.userName})`);
          return;
        }

        // 🛡️ BGFilter Layer 3：脈絡一致性（僅低信心時啟用）
        if (meta.confidence < BG_CONFIDENCE_CONTEXT_CHECK && isContextuallyIncoherent(text, this.conversationHistory)) {
          console.warn(`[BGFilter] ❌ L3 脈絡不一致: conf=${meta.confidence.toFixed(2)} "${text.slice(0, 40)}" (${this.session.userName})`);
          return;
        }

        // 📊 BGFilter: log 通過的 transcript confidence（用於調參）
        if (meta.confidence < 0.7) {
          console.log(`[BGFilter] ⚠️ 低信心通過: conf=${meta.confidence.toFixed(2)} "${text.slice(0, 40)}"`);
        }

        // 🧠 自我察覺反射 — 抓本輪 STT confidence（傳給下一輪 prompt）
        this.currentTurnSttConfidence = meta.confidence;

        // 🔧 Fix M1: 開場白播放期間，排隊而非併發處理（避免音訊重疊）
        if (this.isGreeting) {
          this.pendingTranscript = (this.pendingTranscript || '') + ' ' + text;
          console.log(`[VoicePipeline] 排隊 (開場白中): "${text}"`);
          return;
        }

        // === 打斷後的 final transcript ===
        // 如果剛透過 Deepgram interim 觸發打斷，這個 final 就是用戶插話的內容
        const wasInterrupted = this.interruptedByTranscript;
        if (wasInterrupted) {
          this.interruptedByTranscript = false;
          console.log(`[VoicePipeline] 🎤 打斷後 final: "${text}" (${this.session.userName})`);

          // 🚫 齒輪 2：已移除打斷 filler（跟 TTS 回覆疊加產生雙重語助詞）
        }

        // 🛡️ Anti-Loop：連續重複偵測（防止背景音無限迴圈）
        const now = Date.now();
        // 清理過期記錄
        this.recentFinals = this.recentFinals.filter(f => now - f.time < VoicePipeline.DEDUP_WINDOW_MS);
        // 計算相似次數（用 transcriptsMatch 模糊比對）
        const similarCount = this.recentFinals.filter(f => transcriptsMatch(f.text, text)).length;
        if (similarCount >= VoicePipeline.MAX_SIMILAR_COUNT) {
          console.warn(`[VoicePipeline] 🛡️ Anti-Loop: "${text.slice(0, 30)}" 在 ${VoicePipeline.DEDUP_WINDOW_MS / 1000}s 內已出現 ${similarCount} 次，跳過`);
          return;
        }
        // 速率限制：兩次回覆間最少 N 秒
        const timeSinceLastTurn = now - this.lastTurnEndTime;
        if (this.lastTurnEndTime > 0 && timeSinceLastTurn < VoicePipeline.MIN_TURN_INTERVAL_MS) {
          console.warn(`[VoicePipeline] 🛡️ Rate limit: 距上次回覆僅 ${timeSinceLastTurn}ms，跳過 "${text.slice(0, 30)}"`);
          return;
        }
        // 記錄本次 transcript
        this.recentFinals.push({ text, time: now });

        // Fix 0C: 排隊而非丟棄 — 避免 Deepgram endpointing 把句子拆成兩段時丟失後半段
        // 🔧 QA-H1: 用最新的 final 覆蓋（而非串接），因為後來的 final 通常包含更完整的意思
        if (this.isProcessing) {
          this.pendingTranscript = text;
          console.log(`[VoicePipeline] 排隊 (isProcessing): "${text}"`);
          return;
        }

        this.isProcessing = true;
        this.setPhase('processing');
        this.speechEndTime = Date.now();

        console.log(`[VoicePipeline] Deepgram final: "${text}" (${this.session.userName})`);

        // 🚫 已移除 emitFiller()（filler 跟 TTS 回覆疊加產生雙重語助詞）

        // 送 thinking 狀態
        this.callbacks.sendJson({ type: 'status', state: 'thinking' });

        // 處理回覆（帶入打斷旗標，讓 brain 知道用戶是插話）
        this.handleFinalTranscript(text, wasInterrupted).finally(() => {
          this.isProcessing = false;

          // 處理排隊中的 transcript（用戶說的後半段）
          if (this.pendingTranscript) {
            const pending = this.pendingTranscript.trim();
            this.pendingTranscript = null;
            // 🛡️ Dedup: 跳過與剛處理完的相同文字（Deepgram re-endpointing 防線）
            if (pending && !transcriptsMatch(pending, text)) {
              console.log(`[VoicePipeline] 處理排隊 transcript: "${pending}"`);
              this.processPendingTranscript(pending);
            } else if (pending) {
              console.warn(`[VoicePipeline] 🛡️ Pending dedup: 與剛處理的相同，跳過 "${pending.slice(0, 30)}"`);
            }
          }
        });
      },

      onUtteranceEnd: () => {
        // Deepgram 偵測到一段話結束
        // 通常 onFinalTranscript 會先觸發
      },

      onError: (error) => {
        console.error('[VoicePipeline] Deepgram 錯誤:', error);
        // Deepgram 失敗 → fallback 到 Whisper
        this._useStreamingASR = false;
        this.streamingASR?.close();
        this.streamingASR = null;
      },
    }, {
      // 2026-06-19 N3 per-user endpointing config（沒設定 → undefined → 走預設）
      endpointingMs: earCfg.endpointingMs,
      utteranceEndMs: earCfg.utteranceEndMs,
    });
  }

  // ============ Filler 系統已停用 ============
  // 原因：filler 思考音（嗯...）跟 Claude TTS 回覆疊加，
  // 用戶聽到雙重「嗯...嗯，」很混亂。已移除所有 filler 發射點。
  // 若未來要恢復，請參考 git history。

  // 🚫 以下 filler 相關方法已全部停用（跟 TTS 回覆疊加產生雙重語助詞）
  // classifyTurnSentiment, containsMemoryReference, emitFiller, getDefaultFillerPool
  // 若未來要恢復，請參考 git history

  // ============ 投機 Brain 已移除 ============
  // 2026-06-19: 投機模式（interim → 提前發 brain → final 確認）整套移除
  // 原因：「投機命中後重播」bug — TTS 播完但 final 還沒到時，final 到達會走「TTS 未預熱」
  //       分支重新 enqueue 已生成的句子 → 用戶聽到同一段話兩遍。
  // 簡化後：interim 只負責打斷偵測 + 狀態廣播；brain 僅在 final 到達後啟動。
  // 代價：首句延遲 +700~1500ms（Deepgram endpointing window）— 用穩定性換掉複雜度。

  // ============ 處理排隊 transcript（Fix 0C）============

  private processPendingTranscript(text: string): void {
    // 🛡️ Anti-Loop: 排隊 transcript 也必須通過重複偵測（防 Deepgram re-endpointing）
    const now = Date.now();
    this.recentFinals = this.recentFinals.filter(f => now - f.time < VoicePipeline.DEDUP_WINDOW_MS);
    const similarCount = this.recentFinals.filter(f => transcriptsMatch(f.text, text)).length;
    if (similarCount >= VoicePipeline.MAX_SIMILAR_COUNT) {
      console.warn(`[VoicePipeline] 🛡️ Pending Anti-Loop: "${text.slice(0, 30)}" 已處理過，跳過排隊`);
      return;
    }
    this.recentFinals.push({ text, time: now });

    this.isProcessing = true;
    this.speechEndTime = Date.now();

    console.log(`[VoicePipeline] Deepgram final (pending): "${text}" (${this.session.userName})`);
    // 🚫 已移除 emitFiller()
    this.callbacks.sendJson({ type: 'status', state: 'thinking' });

    this.handleFinalTranscript(text).finally(() => {
      this.isProcessing = false;
      // 如果還有更多排隊的，繼續處理
      if (this.pendingTranscript) {
        const next = this.pendingTranscript.trim();
        this.pendingTranscript = null;
        // 🛡️ Dedup: 跳過與剛處理完的相同文字
        if (next && !transcriptsMatch(next, text)) {
          this.processPendingTranscript(next);
        } else if (next) {
          console.warn(`[VoicePipeline] 🛡️ Pending dedup: 與剛處理的相同，跳過 "${next.slice(0, 30)}"`);
        }
      }
    });
  }

  // ============ 處理最終 transcript ============

  private async handleFinalTranscript(finalText: string, wasInterrupted = false): Promise<void> {
    // INCIDENT-LOG #13 timing 2026-06-20
    const tFinal = Date.now();
    const sttCost = this.speechEndTime ? tFinal - this.speechEndTime : -1;
    console.log(`[Timing] vp.handleFinal entry: STT=${sttCost}ms text="${finalText.slice(0, 40)}"`);

    this.pushHistory({ role: 'user', content: finalText });

    // 👂 聲音場景由 sceneTimer 定時分析（不在每句觸發，避免漏掉講話空檔的聲音）。

    // 打斷情境：額外提示 brain，用戶是在插話，不是重複
    let brainMessage: string;
    if (wasInterrupted && config.gearSurpriseReactionEnabled) {
      // 🎯 齒輪 2：被打斷的驚訝（增強版 prompt）
      brainMessage = `${finalText}\n\n（用戶剛才打斷了你，你被嚇了一跳。先表現出「嚇一跳」的反應（例如「啊？怎麼了？」「欸？」），然後自然回應他說的內容，不要提到他打斷你或重複說話。）`;
    } else if (wasInterrupted) {
      brainMessage = `${finalText}\n\n（用戶剛才打斷了你正在說的話，請直接回應他說的內容，不要覺得奇怪或提到他重複說話）`;
    } else {
      brainMessage = finalText;
    }

    // 2026-06-19: 投機路徑移除 — 直接走正常流程

    // P0.2 — Dual-Brain Judge：Haiku 先判斷該不該回應
    // 預設關閉（VOICE_JUDGE_ENABLED=true 才啟用），避免一次性大改影響 production
    // 啟用後：純應答詞、雜音、太短 transcript 直接 skip，省 Sonnet streaming
    if (process.env.VOICE_JUDGE_ENABLED === 'true') {
      const judge = await shouldRespond(
        finalText,
        this.session.userName,
        this.conversationHistory.slice(-3),
      );
      console.log(
        `[VoicePipeline] [judge] ${judge.source} ${judge.latencyMs}ms ` +
        `→ ${judge.shouldRespond ? 'respond' : 'SKIP'} (${judge.reason})`,
      );
      if (!judge.shouldRespond) {
        this.setPhase('idle');
        this.callbacks.sendJson({ type: 'status', state: 'listening' });
        this.isProcessing = false;
        return;
      }
    }

    console.log(`[Timing] vp.handleFinal → streamingThinkAndSpeak: +${Date.now() - tFinal}ms`);
    if (isVoiceBrainAvailable()) {
      await this.streamingThinkAndSpeak(finalText, brainMessage);
    } else {
      await this.blockingThinkAndSpeak(finalText, brainMessage);
    }
  }

  // ============ 🔁 Echo Filter 已抽出 ============
  // P1 extraction #3: transcriptsMatch + isEcho + levenshtein 搬到 ./voice/echo-filter.ts
  // call sites 直接用 imported 純函式，不再透過 this. 包裝

  // ============ 🛡️ BGFilter 已抽出 ============
  // P1 extraction #2: 三層背景音過濾搬到 ./voice/bg-filter.ts
  // 公開常數 + 純函式形式，call sites 已改用 module 函式

  // ============ 公開方法 ============

  async speakGreeting(greeting: string): Promise<void> {
    this.isGreeting = true; // 保護開場白不被 Deepgram 迴音打斷
    this.setPhase('greeting');
    this.callbacks.sendJson({ type: 'status', state: 'speaking' });
    this.isSpeaking = true;
    this.recentSpokenText = greeting; // Echo Gate 追蹤
    this.pushHistory({ role: 'assistant', content: greeting });

    // 🔧 等前端初始化播放管道（WebSocket + warmUpPlayback + startMic + AudioContext）
    // v2: 從 1000ms 降到 500ms（前端 warmUpPlayback 已預建 AudioContext + ScriptProcessor）
    await new Promise(r => setTimeout(r, 500));

    await this.streamSpeak(greeting);
    this.isGreeting = false;
    this.setPhase('idle');

    // 🔧 Fix M1: 開場白結束後，處理排隊中的 transcript
    if (this.pendingTranscript) {
      const pending = this.pendingTranscript.trim();
      this.pendingTranscript = null;
      if (pending) {
        console.log(`[VoicePipeline] 開場白結束，處理排隊 transcript: "${pending.slice(0, 30)}"`);
        this.processPendingTranscript(pending);
      }
    }
  }

  /**
   * 收到音訊 chunk
   * Streaming ASR 模式：即時轉發到 Deepgram
   * Whisper fallback：蒐集到 buffer
   */
  onAudioChunk(data: Buffer): void {
    if (this._useStreamingASR && this.streamingASR) {
      this.streamingASR.feedAudio(data);
      // 👂 tee 一份副本給場景分析（不影響 Deepgram）。rolling cap ~12s @16k/16/mono。
      this.sceneAudioChunks.push(data);
      this.sceneAudioBytes += data.length;
      const SCENE_CAP = 16000 * 2 * 12; // ~12 秒
      while (this.sceneAudioBytes > SCENE_CAP && this.sceneAudioChunks.length > 1) {
        this.sceneAudioBytes -= this.sceneAudioChunks.shift()!.length;
      }
    } else {
      if (!this.isCollecting) this.isCollecting = true;
      this.audioChunks.push(data);
    }
  }

  /**
   * Whisper fallback: VAD 偵測到用戶停止說話
   */
  async onSpeechEnd(): Promise<void> {
    // Streaming ASR 模式不需要這個（Deepgram 自己偵測）
    if (this._useStreamingASR) return;

    if (this.audioChunks.length === 0) return;
    this.isCollecting = false;

    const fullAudio = Buffer.concat(this.audioChunks);
    this.audioChunks = [];

    if (fullAudio.length < 3200) {
      this.callbacks.sendJson({ type: 'status', state: 'listening' });
      return;
    }

    this.callbacks.sendJson({ type: 'status', state: 'thinking' });
    this.speechEndTime = Date.now();

    // 🚫 已移除 emitFiller()

    let userText: string;
    try {
      userText = await this.transcribeAudio(fullAudio);
    } catch (err) {
      console.error('[VoicePipeline] ASR 失敗:', err);
      await this.streamSpeak('抱歉，我沒聽清楚，你再說一次？');
      return;
    }

    if (!userText.trim()) {
      this.callbacks.sendJson({ type: 'status', state: 'listening' });
      return;
    }

    console.log(`[VoicePipeline] Whisper: "${userText}" (${this.session.userName})`);
    this.pushHistory({ role: 'user', content: userText });

    if (isVoiceBrainAvailable()) {
      await this.streamingThinkAndSpeak(userText);
    } else {
      await this.blockingThinkAndSpeak(userText);
    }
  }

  // ============ Brain 流程 ============

  private streamingThinkAndSpeak(userText: string, brainMessage?: string): Promise<void> {
    this.brainAbortController = new AbortController();

    // 建立 TTS 播放器（normal 模式 — 無 canSend 限制）
    const player = new TTSPlayer(
      (chunk) => { this.recordCallAudio(chunk); this.callbacks.sendAudio(chunk); },
      undefined,
      (msg) => this.callbacks.sendJson(msg),  // 🔧 TTS 重試時送 filler
    );
    this.ttsPlayer = player;

    let fullResponse = '';
    let resolved = false;

    return new Promise<void>((resolve) => {
      let firstSentence = true;

      // 🔧 QA-C3: 暴露 resolve 給 interrupt() 使用，防止 Promise 永遠不 resolve
      this._streamingResolve = () => {
        if (!resolved) { resolved = true; resolve(); }
      };

      // 設定播完回呼（aborted=true 時由打斷方自行處理收尾，這裡只處理自然播完）
      player.onAllDone = ({ aborted }) => {
        if (safetyTimer) clearTimeout(safetyTimer);
        if (!aborted) {
          this.finalizeTurn(userText, fullResponse);
        }
        if (!resolved) { resolved = true; resolve(); }
      };

      // 🔧 安全網：30 秒後強制收尾（防止 brain 掛住或 TTS 永遠不完成）
      const safetyTimer = setTimeout(() => {
        if (resolved) return;
        console.warn(`[VoicePipeline] ⚠️ streamingThinkAndSpeak 安全網觸發 (30s 超時) — 強制收尾`);
        // 停掉所有進行中的工作
        if (this.brainAbortController) {
          this.brainAbortController.abort();
          this.brainAbortController = null;
        }
        if (this.ttsPlayer) {
          // abort() → fireAllDone({ aborted: true }) → onAllDone 不會再 finalizeTurn
          this.ttsPlayer.abort();
          this.ttsPlayer = null;
        }
        this.isSpeaking = false;
        this.setPhase('idle');
        this.callbacks.sendJson({ type: 'audio:done' });
        this.callbacks.sendJson({ type: 'status', state: 'listening' });
        if (fullResponse) {
          this.saveConversation(userText, fullResponse);
        }
        if (!resolved) { resolved = true; resolve(); }
      }, 30_000);

      // 👂 consume-once + 25s 過期：偵測到的聲音事件只反應「一次」、太舊不用。
      // 守門已在 describeAudioScene（沒事件回 null），所以這裡有值＝真有事件。
      const sceneNow = (this.lastAudioScene && Date.now() - this.lastAudioSceneAt < 25_000)
        ? this.lastAudioScene
        : undefined;
      this.lastAudioScene = undefined;

      // 🫧 情緒底色：30s 內的 arousal 才用（不 consume，是持續心情）
      const arousalNow = (this.lastArousal !== undefined && Date.now() - this.lastArousalAt < 30_000)
        ? this.lastArousal
        : undefined;

      streamVoiceBrain({
        userId: this.session.dbUserId!,
        lineUserId: this.session.userId,
        userName: this.session.userName,
        message: brainMessage || userText,
        conversationHistory: this.conversationHistory.slice(-12),
        abortSignal: this.brainAbortController!.signal,
        prefetchedContext: this.prefetchedContext || undefined,
        skipMemory: true, // 跳過記憶搜尋，省 200-500ms
        metaSignals: this.lastTurnMeta,  // 🧠 自我察覺：傳上一輪 meta 給人格看
        audioScene: sceneNow,  // 👂 偵測到的聲音事件（consume-once，沒事件就 undefined）
        arousal: arousalNow,   // 🫧 聲音活化度（低=累）；voice-brain 自己決定要不要溫柔關心

        // 2026-06-19 — 人格啟動 tool 時、推音效給前端
        onToolUse: (toolName, phase) => {
          this.callbacks.sendJson({ type: 'fx:tool', tool: toolName, phase });
        },

        onSentence: (sentence) => {
          // 🛡️ 第一句去除開頭語氣詞（filler 思考音已經播了，避免「嗯...嗯，」疊加）
          if (firstSentence) {
            const original = sentence;
            sentence = stripLeadingInterjection(sentence);
            if (sentence !== original) {
              console.log(`[VoicePipeline] 🧹 去除第一句語氣詞: "${original.slice(0, 30)}" → "${sentence.slice(0, 30)}"`);
            }

            const elapsed = Date.now() - this.speechEndTime;
            console.log(`[VoicePipeline] 第一句到達: ${elapsed}ms`);
            this.currentTurnFirstSentMs = elapsed;  // 🧠 自我察覺：抓本輪首句延遲
            this.setPhase('speaking');
            // 🔧 Fix: 先送 audio:clear 清空前端可能殘留的投機音訊 buffer
            this.callbacks.sendJson({ type: 'audio:clear' });
            this.callbacks.sendJson({ type: 'status', state: 'speaking' });
            this.isSpeaking = true;
            this.recentSpokenText = ''; // 清空，開始新一輪
            firstSentence = false;
          }

          // 🛡️ 技術詞彙洩漏偵測（Claude 打破第四面牆）
          if (containsTechLeak(sentence)) {
            console.warn(`[VoicePipeline] 🚫 技術詞彙洩漏攔截: "${sentence.slice(0, 50)}"`);
            sentence = '蛤？你在說什麼啦，聽不懂。';
          }

          // 🛡️ 控制標籤/舞台指示不進 TTS（唯一出口 strip）
          // 2026-07-03：串流通話首句為低延遲提早 flush，[EMOTION:x] 等易被切在 chunk 邊界、per-chunk sanitize 漏掉，
          // 導致她把「EMOTION fluent」念出來。這裡在 enqueue 前一律清乾淨。
          sentence = sentence
            // 2026-07-13：B2 拿掉工具但 prompt 還叫她 call search_memory → 她吐出 <search_memory><time_range>last_hour</time_range>… 的 XML
            // 直接流進 TTS（被唸出來 + 全英文讓語言判成 English 走英文聲音 → 雜音）。這裡先把整個工具呼叫塊連內容清掉，再清殘留尖括號標籤。
            .replace(/<(search_memory|verify_my_memory|read_destiny)\b[^>]*>[\s\S]*?<\/\1>/gi, '') // 成對工具塊連內容
            .replace(/<\/?(?:search_memory|verify_my_memory|read_destiny|time_range|query|keyword|top_k|threshold)\b[^>]*>/gi, '') // 被串流切斷的殘缺工具標籤
            .replace(/<\/?[a-zA-Z][^>]{0,60}>/g, '')                 // 其餘 XML 式尖括號標籤（保留 MiniMax <#0.5#> 停頓，因它以 # 開頭不吃這條）
            .replace(/<\/?[a-zA-Z][a-zA-Z_]*$/,'')                   // 句尾被串流切斷的殘缺標籤碎片（如 </time_ra）
            .replace(/\[[^\]]*\]/g, '')                              // 完整方括號控制標籤（EMOTION/REPLY_MODE/ACCENT… 一律清）
            .replace(/\[?\s*(?:EMOTION|REPLY_MODE|ACCENT|INVITE_CALL|LONGING_TOUCHED|IDENTIFY)\s*[:：]?\s*[A-Za-z_]*\]?/gi, '') // 被串流切斷的殘缺標籤碎片（治「唸出 EMOTION happy」）
            .replace(/^[A-Za-z_]{0,12}\]/,'')                        // 上一句被切、殘留在句首的標籤尾巴（如「py]」）
            .replace(/\*[^*\n]+\*/g, '')                             // *斜體舞台指示*
            .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}\u{FE00}-\u{FE0F}\u{200D}]/gu, '') // emoji：講電話聽不到、送進 MiniMax 沒意義（🥺💕 等），一律清
            .replace(/[—―‒–－]+|─{2,}|--+/g, '，')                    // 破折號/長橫線 → 逗號（MiniMax 會把「——」唸成「七七」）
            .replace(/，{2,}/g, '，')
            .replace(/\s{2,}/g, ' ')
            .trim();
          if (!sentence) return;  // 清完變空 → 不 enqueue

          this.recentSpokenText += sentence; // Echo Gate 追蹤
          player.enqueue(sentence);
        },

        onDone: (response) => {
          fullResponse = response;
          this.pushHistory({ role: 'assistant', content: response });

          if (firstSentence) {
            // Brain 完成但沒產出任何句子
            if (safetyTimer) clearTimeout(safetyTimer);
            this.setPhase('idle');
            this.callbacks.sendJson({ type: 'status', state: 'listening' });
            if (!resolved) { resolved = true; resolve(); }
            return;
          }

          // 告知 player brain 已完成 → 佇列清空時觸發 onAllDone
          player.markBrainDone();

          // 🔧 安全網：markBrainDone 後若 onAllDone 遲遲未觸發 → 強制收尾
          // 防止因 race condition 導致 onAllDone 被消耗或未觸發
          // 策略：2s 後開始檢測，若 player 已 idle（TTS 播完）但 Promise 未 resolve → 強制收尾
          //        若 player 仍在播放 → 等 30s 安全網處理
          setTimeout(() => {
            if (resolved) return;
            const playerIdle = !this.ttsPlayer || this.ttsPlayer.isIdle;
            const playerState = this.ttsPlayer
              ? `playing=${this.ttsPlayer.isPlaying}, queue=${this.ttsPlayer.queueLength}, idle=${this.ttsPlayer.isIdle}, aborted=${this.ttsPlayer.isAborted}`
              : 'null';
            if (playerIdle) {
              // Player 已結束但 onAllDone 未觸發 → 強制收尾
              console.warn(`[VoicePipeline] ⚠️ markBrainDone 2s 安全網觸發（player=${playerState}）— 強制 finalizeTurn`);
              if (safetyTimer) clearTimeout(safetyTimer);
              if (this.ttsPlayer) {
                this.ttsPlayer.abort();
                this.ttsPlayer = null;
              }
              this.finalizeTurn(userText, fullResponse);
              if (!resolved) { resolved = true; resolve(); }
            } else {
              // Player 仍在播放 → TTS 需要更多時間，不打斷（30s 安全網兜底）
              console.log(`[VoicePipeline] markBrainDone 2s 後 TTS 仍在播放（${playerState}），等待自然完成`);
            }
          }, 2000);
        },

        onError: (error) => {
          if (safetyTimer) clearTimeout(safetyTimer);
          console.error('[VoicePipeline] Claude 錯誤:', error);
          this.streamSpeak('嗯......好像怪怪的。').then(() => {
            this.isSpeaking = false;
            this.setPhase('idle');
            this.callbacks.sendJson({ type: 'audio:done' });
            this.callbacks.sendJson({ type: 'status', state: 'listening' });
            if (!resolved) { resolved = true; resolve(); }
          });
        },
      });
    });
  }

  private async blockingThinkAndSpeak(userText: string, brainMessage?: string): Promise<void> {
    let aiResponse: string;
    try {
      if (!this.session.dbUserId) {
        aiResponse = '你好呀，你是誰呢？';
      } else {
        const spaceContext = await this.getVoiceCallSpace();
        const result = await processMessage({
          userId: this.session.dbUserId,
          lineUserId: this.session.userId,
          message: brainMessage || userText,
          messageType: 'text',
          spaceContext,
        });
        aiResponse = result.response;
      }
    } catch (err) {
      console.error('[VoicePipeline] Brain 失敗:', err);
      await this.streamSpeak('嗯......好像怪怪的。');
      return;
    }

    this.pushHistory({ role: 'assistant', content: aiResponse });
    this.callbacks.sendJson({ type: 'status', state: 'speaking' });
    this.isSpeaking = true;         // 🐛 Fix: 標記開始說話
    this.setPhase('speaking');      // 🐛 Fix: 設定階段
    await this.streamSpeak(aiResponse);
    this.finalizeTurn(userText, aiResponse);
  }

  // ============ TTS ============
  // TTS 播放邏輯已統一到 TTSPlayer 類

  private finalizeTurn(userText: string, aiResponse: string): void {
    this.isSpeaking = false;
    this.recentSpokenText = ''; // Echo Gate 清空
    this.lastTurnEndTime = Date.now(); // 🛡️ Anti-Loop：記錄回覆結束時間
    this.setPhase('idle');
    this.callbacks.sendJson({ type: 'audio:done' });
    this.callbacks.sendJson({ type: 'status', state: 'listening' });
    this.saveConversation(userText, aiResponse);

    // 🧠 自我察覺反射：把本輪 meta 移到 lastTurnMeta，下一輪 prompt 人格會看到
    this.lastTurnMeta = {
      sttConfidence: this.currentTurnSttConfidence ?? undefined,
      firstSentenceMs: this.currentTurnFirstSentMs ?? undefined,
      wasInterrupted: this.currentTurnWasInterrupted,
    };
    this.currentTurnSttConfidence = null;
    this.currentTurnFirstSentMs = null;
    this.currentTurnWasInterrupted = false;

    // 🚫 filler 已停用，不再需要情感分類

    // 🧠 背景記憶搜尋：用本輪對話內容搜尋相關記憶，注入下一輪的 context
    // 不阻塞當前流程，下一輪對話時自動帶入（省掉即時搜尋的 200-500ms）
    //
    // 🎯 記憶碎片策略：搜尋 top-5 但只注入 3 條，降低門檻到 0.35
    // 這樣可以撈到更多「間接相關」的舊記憶，讓包容能自然地提起過去的事
    if (this.prefetchedContext && this.session.userId) {
      const searchQuery = `${userText} ${aiResponse}`.slice(0, 100);
      searchMemories(searchQuery, 5, 0.35, this.session.userId)
        .then(memories => {
          if (this.prefetchedContext && memories.length > 0) {
            // 取 top-3（最相關的 + 一些間接相關的舊記憶）
            this.prefetchedContext.cachedMemories = memories.slice(0, 3);
            console.log(`[VoicePipeline] 背景記憶搜尋: ${memories.length} 條候選, 注入 ${Math.min(memories.length, 3)} 條`);
          }
        })
        .catch(() => { /* 搜尋失敗不影響通話 */ });
    }
  }

  // ============ 控制 ============

  interrupt(): void {
    this.isGreeting = false; // 手動打斷時清除開場白保護

    if (this.brainAbortController) {
      this.brainAbortController.abort();
      this.brainAbortController = null;
    }

    // 🎵 軟著陸：先通知前端 fade-out，延遲後才停 TTS
    // 前端收到 audio:fadeout → 300ms 內把音量降到 0
    // 後端延遲 300ms 後才 abort TTS，讓前端有時間完成淡出
    if (this.ttsPlayer && this.isSpeaking) {
      console.log(`[VoicePipeline] 軟著陸打斷 (${this.session.userName})`);

      // 🔇 P0 fix: 先 mute 舊 player，立刻切斷音訊輸出（防止 300ms 間隙雙重音訊）
      const playerToAbort = this.ttsPlayer;
      playerToAbort.mute();

      this.callbacks.sendJson({ type: 'audio:fadeout' });

      // 立刻標記狀態（防止再送音訊 / 再次觸發打斷）
      this.isSpeaking = false;
      this.recentSpokenText = '';
      this.setPhase('idle');

      // 覆寫 onAllDone：interrupt 自行管理收尾，abort 後只送 audio:done
      const sendJsonRef = this.callbacks.sendJson;
      playerToAbort.onAllDone = () => {
        sendJsonRef({ type: 'audio:done' });
      };
      this.ttsPlayer = null;
      // 延遲 abort TTS（讓前端 fade-out 完成，但 mute 已確保不會再送音訊）
      setTimeout(() => playerToAbort.abort(), 300);
    } else {
      // 沒有在播音訊 → 直接停
      if (this.ttsPlayer) {
        // abort() → onAllDone({ aborted: true })，callback 自行判斷
        this.ttsPlayer.abort();
        this.ttsPlayer = null;
      }
      this.isSpeaking = false;
      this.recentSpokenText = '';
      this.setPhase('idle');
    }

    // 🔧 QA-C3: resolve streamingThinkAndSpeak 的 Promise，防止 memory leak
    if (this._streamingResolve) {
      this._streamingResolve();
      this._streamingResolve = null;
    }

    // 🔧 Fix: abort brain 後 streamVoiceBrain 的 catch block 會靜默 return
    // → isProcessing 卡死 → 所有後續 transcript 都排隊但永遠不處理
    // 修復：主動重置 isProcessing 並立刻處理排隊中的 transcript
    if (this.isProcessing) {
      this.isProcessing = false;
      if (this.pendingTranscript) {
        const pending = this.pendingTranscript.trim();
        this.pendingTranscript = null;
        if (pending) {
          console.log(`[VoicePipeline] 打斷後處理排隊 transcript: "${pending.slice(0, 30)}"`);
          // 使用 setTimeout 避免在 interrupt 流程中重入
          setTimeout(() => this.processPendingTranscript(pending), 50);
        }
      }
    }

    this.callbacks.sendJson({ type: 'status', state: 'listening' });
  }

  destroy(): void {
    // 🔒 QA-R2: 冪等保護 — 防止 call:end + WebSocket close 重複呼叫
    if (this._isDestroyed) return;
    this._isDestroyed = true;

    // 👂 停止聲音場景定時掃描
    if (this.sceneTimer) { clearInterval(this.sceneTimer); this.sceneTimer = undefined; }

    // QA-C3: resolve 未完成的 Promise
    if (this._streamingResolve) { this._streamingResolve(); this._streamingResolve = null; }
    if (this.brainAbortController) {
      this.brainAbortController.abort();
      this.brainAbortController = null;
    }
    this.isProcessing = false; // 🔒 QA-R2-H3: 防止 brain 串流中 destroy 導致 isProcessing 卡死
    if (this.ttsPlayer) {
      // destroy 時不需要任何 callback 動作，直接 abort
      // abort() → fireAllDone({ aborted: true })，現有 callback 會判斷 aborted
      this.ttsPlayer.abort();
      this.ttsPlayer = null;
    }
    this.audioChunks = [];

    // 關閉 Deepgram
    if (this.streamingASR) {
      this.streamingASR.close();
      this.streamingASR = null;
    }

    // ⚠️ 不再呼叫 closePooledConnection()
    // keep-alive agent 是全局共用的，單一 session 結束不應關閉
    // 否則其他正在通話的 session 的 TTS 會全部 fetch failed + crash

    // 🆕 非同步生成通話摘要 → 存長期記憶 + 更新 DB（不阻塞 destroy）
    if (this.session.dbUserId && this.conversationHistory.length >= 1) {
      const history = [...this.conversationHistory]; // 複製一份，避免被 GC
      const session = this.session;
      this.saveCallSummary(history, session)
        .catch(err => console.error('[VoicePipeline] 通話摘要儲存失敗:', err));
    }
  }

  /**
   * 非同步生成通話摘要並存入 Vectorize 長期記憶 + 更新 DB conversations
   */
  private async saveCallSummary(
    history: Array<{ role: 'user' | 'assistant'; content: string }>,
    session: VoiceSession
  ): Promise<void> {
    // P0.3 冪等保護：destroy() 觸發 + 任何外部重試都只跑一次
    if (this._finalized) {
      console.log('[VoicePipeline] saveCallSummary 已執行過，跳過');
      return;
    }
    this._finalized = true;

    const summary = await generateCallSummary(history, session.userName);
    if (!summary.trim()) return;

    // 🔒 內心獨白（私密內層，借鏡語靈 Yuling）：她沒說出口的真實想法 → inner_monologue。
    //    掛斷後才生成、**永不進 TTS / 逐字稿**；fire-and-forget，獨立失敗、不擋摘要流程。
    if (session.dbUserId) {
      const dbUid = session.dbUserId;
      generateInnerMonologue(history, session.userName)
        .then(async (inner) => {
          if (!inner.trim()) return;
          await recordMonologue({
            userId: dbUid,
            kind: 'post_call',
            content: inner,
            context: { session_id: session.id, turn_count: history.length },
          });
          console.log(`[VoicePipeline] 📓 內心獨白已存 (${session.userName})`);
        })
        .catch((e) => console.error('[VoicePipeline] 內心獨白存失敗:', e?.message));
    }

    const durationSec = Math.round((Date.now() - session.startedAt.getTime()) / 1000);

    // 🎙️ 通話錄音上傳 R2（她的語音 MP3 chunks 接起來）→ URL 掛進 call_summary，之後可回聽/餵記憶
    // fire-safe：失敗只 log、不擋摘要。目前只錄「她的聲音」；對方的話已在逐字稿裡。
    let recordingUrl = '';
    try {
      if (this.recordedAudio.length > 0) {
        const merged = Buffer.concat(this.recordedAudio);
        const ab = merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength) as ArrayBuffer;
        const { uploadToR2 } = await import('./mouth.js');
        const up = await uploadToR2(ab);
        recordingUrl = up.url;
        console.log(`[VoicePipeline] 🎙️ 通話錄音已存 R2 (${Math.round(merged.length / 1024)}KB, ${durationSec}s): ...${recordingUrl.slice(-32)}`);
      }
    } catch (e: any) {
      console.warn('[VoicePipeline] 通話錄音上傳失敗（不擋摘要）:', e?.message);
    }

    // P0.3 兩個 side effect 並行 + 獨立失敗（借鏡 ailivex asyncio.gather 模式）
    // 改前：sequential await — Vectorize 失敗就吃掉後面的 DB INSERT
    // 改後：Promise.allSettled — 各自獨立、互不阻塞
    const results = await Promise.allSettled([
      // ① 存入 Vectorize 長期記憶
      saveMemory(
        summary,
        {
          type: 'voice_call_summary',
          source: 'voice',
          speaker: session.userName,
          session_id: session.id,
          duration_sec: durationSec,
          recording_url: recordingUrl,
        },
        session.userId,
        undefined,
        'personal',
      ),
      // ② 寫 DB conversations 獨立 call_summary row（Fix B 行為保留）
      (async () => {
        if (!session.dbUserId) return false;
        const userParts = history.filter((h) => h.role === 'user').map((h) => h.content);
        const userSummary = userParts.length > 0
          ? userParts.join(' / ').slice(0, 500)
          : '（用戶未說話 — 獨腳戲掛斷）';
        await query(
          `INSERT INTO conversations
             (user_id, message_type, user_message, ai_response, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            session.dbUserId,
            'call_summary',
            userSummary,
            summary,
            JSON.stringify({
              type: 'voice_call_summary',
              session_id: session.id,
              duration_sec: durationSec,
              turn_count: history.length,
              recording_url: recordingUrl,
            }),
          ],
        );
        console.log(`[VoicePipeline] ✅ call_summary row 已 INSERT (session: ${session.id})`);
        return true;
      })(),
    ]);

    // 各自 log 成敗（互不阻塞）
    const labels = ['Vectorize 記憶', 'DB conversations'];
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        console.error(`[VoicePipeline] finalize ${labels[i]} 失敗:`, r.reason);
      } else if (r.value) {
        console.log(`[VoicePipeline] ✅ finalize ${labels[i]} 成功`);
      }
    });
  }

  // ============ 內部工具 ============

  private streamSpeak(text: string): Promise<void> {
    return new Promise((resolve) => {
      this.isSpeaking = true;
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        if (safetyTimer) clearTimeout(safetyTimer);
        this.isSpeaking = false;
        this.ttsPlayer = null;
        this.callbacks.sendJson({ type: 'audio:done' });
        this.callbacks.sendJson({ type: 'status', state: 'listening' });
        resolve();
      };

      const player = new TTSPlayer(
        (chunk) => { this.recordCallAudio(chunk); this.callbacks.sendAudio(chunk); },
        undefined,
        (msg) => this.callbacks.sendJson(msg),  // 🔧 TTS 重試時送 filler
      );
      this.ttsPlayer = player;
      player.enqueue(text);
      player.markBrainDone(); // 只有一句，直接標記完成
      player.onAllDone = () => cleanup(); // 無論 aborted 與否都 cleanup

      // 🔧 安全網：15 秒後強制收尾（abort → onAllDone → cleanup，冪等安全）
      const safetyTimer = setTimeout(() => {
        if (done) return;
        console.warn(`[VoicePipeline] ⚠️ streamSpeak 安全網觸發 (15s): "${text.slice(0, 30)}"`);
        if (this.ttsPlayer === player) {
          player.abort(); // 觸發 onAllDone → cleanup
        } else {
          cleanup(); // player 已被替換，直接 cleanup
        }
      }, 15_000);
    });
  }

  /**
   * 👂 B 階段：sceneTimer 每 7s 呼叫，掃 rolling buffer 的非語言聲音，async 不擋回話。
   * 兩段式（YAMNet 前置 + Gemini 描述）：
   *   1) 本地 YAMNet 先判斷「有沒有事件」— 便宜、不漏空檔、當守門（沒事件就不打擾）。
   *   2) 有事件才升級給 Gemini 生成自然「親耳聽到」描述（Gemini 不可用就用 YAMNet 標籤兜）。
   * consume-once 注入：只在真有事件時 set lastAudioScene。
   */
  private analyzeSceneTick(): void {
    if (this._isDestroyed || !this._useStreamingASR) return;
    const chunks = this.sceneAudioChunks;
    this.sceneAudioChunks = [];   // 消費本視窗（同一聲音不重複偵測）
    this.sceneAudioBytes = 0;
    if (chunks.length === 0) return;
    const pcm = Buffer.concat(chunks);
    if (pcm.length < 32000) return; // < ~1s，太短不分析
    // fire-and-forget，絕不擋通話。
    classifyYamnet(pcm)
      .then(async (events) => {
        if (this._isDestroyed || events.length === 0) return; // 守門：沒事件 → 不打擾正常對話
        // 主力＝本地 YAMNet（免費、無帳務雷、低延遲）：直接用偵到的事件組場景描述（取顯著的前 2 個）。
        let text = `我聽到${events.slice(0, 2).map((e) => e.zh).join('、')}`;
        // Gemini 僅作可選增強（SCENE_USE_GEMINI=true 才開）：生成更自然的「親耳聽到」描述。
        if (config.sceneUseGemini) {
          const wav = pcmToWav(pcm, 16000, 16, 1);
          const scene = await describeAudioScene(wav, 'audio/wav').catch(() => null);
          if (scene) text = scene;
        }
        this.lastAudioScene = text;
        this.lastAudioSceneAt = Date.now();
        console.log(`[VoicePipeline] 👂 YAMNet[${events.map((e) => `${e.label}:${e.score}`).join(', ')}] → ${text}`);
        // #1 主動反應：偵測到顯著瞬時聲、且此刻是沉默空檔 → 當下主動驚呼（不等對方開口）
        this.maybeReactToSound(events);
      })
      .catch(() => {});

    // 🫧 情緒底色（vocal affect）：節流每 2 tick(~14s)，async 不擋通話。
    // 只記 arousal（累/沒力，跨語言可靠）；valence 中文未驗、家人勿用。
    if (++this.affectTick % 2 === 0) {
      classifyAffect(pcm)
        .then((a) => {
          if (this._isDestroyed || !a) return;
          this.lastArousal = a.arousal;
          this.lastArousalAt = Date.now();
          console.log(`[VoicePipeline] 🫧 affect arousal=${a.arousal} (valence=${a.valence}, dom=${a.dominance})`);
        })
        .catch(() => {});
    }
  }

  /**
   * #1 聲音→主動反應（reflex）：偵測到顯著瞬時聲、此刻又是沉默空檔 → 當下主動驚呼一句、不等對方開口。
   * 反射式短句（不走 brain、省延遲、像人反射）。重重守門避免蓋過對方：
   *   只在 idle、沒在說話/處理/開場，距上次反應 >15s 才觸發；用戶一開口 barge-in 會打斷、echo gate 擋自己聲音。
   */
  private maybeReactToSound(events: { label: string; zh: string; score: number }[]): void {
    if (this._isDestroyed) return;
    const top = events[0];
    if (!top || top.score < 0.5) return;
    const REACT: Record<string, string[]> = {
      'Cough': ['欸你咳嗽了？還好嗎？', '你咳嗽欸，是不是著涼了？'],
      'Sneeze': ['哈啾～你打噴嚏了！', '你打噴嚏欸，有人在想你囉？'],
      'Clapping': ['你在拍手嗎？怎麼啦～', '欸我聽到你拍手！'],
      'Knock': ['有人敲門嗎？', '我聽到敲門聲欸，要去看看嗎？'],
      'Bang': ['欸什麼聲音？嚇我一跳', '剛那一聲好大，你還好嗎？'],
      'Slam': ['誰摔門啦？', '門好大聲欸，怎麼了？'],
      'Smash, crash': ['欸什麼東西破掉了嗎？', '那聲音好像有東西打翻，沒事吧？'],
      'Breaking': ['有東西破掉了嗎？小心點～', '欸是不是什麼破掉了？'],
      'Whistling': ['你在吹口哨喔～心情很好嘛', '聽到你吹口哨，今天開心喔？'],
      'Laughter': ['你笑什麼啦～', '聽你笑我也想笑欸'],
      'Crying, sobbing': ['欸…你還好嗎？我聽到了', '怎麼了？別哭…我在這'],
      'Gasp': ['你怎麼了？嚇到了嗎？', '欸你倒抽一口氣，還好嗎？'],
    };
    const lines = REACT[top.label];
    if (!lines) return;                                       // 只反射高顯著的那幾種瞬時聲
    if (this.isSpeaking || this.isProcessing || this.isGreeting || this._phase !== 'idle') return; // 必須是沉默空檔
    if (Date.now() - this.lastSoundReactAt < 15000) return;   // debounce 15s
    this.lastSoundReactAt = Date.now();
    const line = lines[this.soundReactCount++ % lines.length];
    console.log(`[VoicePipeline] 👂✨ 主動反應(${top.label}:${top.score}) → "${line}"`);
    this.isSpeaking = true;
    this.setPhase('speaking');
    this.recentSpokenText = line;                             // echo gate：擋自己的聲音被當成用戶說話
    this.pushHistory({ role: 'assistant', content: line });
    this.callbacks.sendJson({ type: 'status', state: 'speaking' });
    this.streamSpeak(line)
      .catch(() => {})
      .finally(() => {
        this.isSpeaking = false;
        if (this._phase === 'speaking') {
          this.setPhase('idle');
          this.callbacks.sendJson({ type: 'status', state: 'listening' });
        }
      });
  }

  private async transcribeAudio(pcmBuffer: Buffer): Promise<string> {
    const wavBuffer = pcmToWav(pcmBuffer, 16000, 16, 1);

    const formData = new FormData();
    const audioBlob = new Blob([wavBuffer], { type: 'audio/wav' });
    formData.append('file', audioBlob, 'voice-call.wav');
    formData.append('model', 'whisper-1');
    // STT name hint — bias Whisper 對家族姓名/公司/博論術語的辨識
    formData.append('prompt', WHISPER_NAME_HINT);

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${config.openaiApiKey}` },
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`Whisper error: ${response.status}`);
    }

    const data = await response.json() as { text: string };
    return data.text;
  }

  private async getVoiceCallSpace() {
    try {
      const r = await query(
        `SELECT id, name FROM spaces WHERE source_type = 'user' AND source_id = $1 LIMIT 1`,
        [this.session.userId]
      );
      if (r.rows.length > 0) {
        return { spaceId: r.rows[0].id, spaceName: r.rows[0].name || '語音通話', sourceType: 'user' as const, memberCount: 2, rules: {} };
      }
    } catch { /* spaces 表可能不存在 */ }
    return { spaceId: 0, spaceName: '語音通話', sourceType: 'user' as const, memberCount: 2, rules: {} };
  }

  private async saveConversation(userMsg: string, aiResponse: string): Promise<void> {
    if (!this.session.dbUserId) return;
    try {
      await query(
        `INSERT INTO conversations (user_id, message_type, user_message, ai_response, metadata)
         VALUES ($1, 'audio', $2, $3, $4)`,
        [this.session.dbUserId, userMsg, aiResponse, JSON.stringify({
          type: 'voice_call',
          session_id: this.session.id,
        })]
      );
    } catch (err) {
      console.error('[VoicePipeline] 存對話記錄失敗:', err);
    }
  }
}

// ============ Voice utilities 已抽出 ============
// P1 extraction #4: stripLeadingInterjection / containsTechLeak / pcmToWav
// 搬到 ./voice/utils.ts — 都是純函式 + 純常數，邏輯不動
