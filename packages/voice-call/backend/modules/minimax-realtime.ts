/**
 * 🔊 MiniMax Realtime TTS — WebSocket 串流語音合成 v2
 *
 * v2 改進：連線池模式
 * - 一條 WebSocket 連線可以連續處理多個句子（task）
 * - 省去每句話重新 TCP + TLS + WS 握手的 100-400ms
 * - 句子結束後連線保持 idle，下一句直接復用
 * - idle 超過 30 秒自動關閉（避免資源浪費）
 *
 * 協議：
 *   1. 連線 wss://api.minimax.io/ws/v1/t2a_v2
 *   2. 收到 connected_success
 *   3. 每個句子：task_start → task_started → task_continue(text) → audio chunks → is_final → task_finish
 *   4. 同一連線可以重複步驟 3
 */

import WebSocket from 'ws';
import { config } from '../config.js';
import { detectEmotion } from './mouth.js';
import * as OpenCC from 'opencc-js';

// 繁→簡（Minimax 用簡體發音更準）
const twToSp = OpenCC.Converter({ from: 'tw', to: 'cn' });

// ============ 型別 ============

export interface MinimaxStreamOptions {
  /** 要合成的文字 */
  text: string;
  /** 語言（auto 自動偵測） */
  language?: 'zh' | 'en' | 'auto';
  /** 每收到一段音訊的回調（MP3 binary） */
  onAudioChunk: (chunk: Buffer) => void;
  /** 全部音訊播完 */
  onDone: () => void;
  /** 錯誤 */
  onError: (error: string) => void;
}

interface MinimaxWSMessage {
  event?: string;
  data?: {
    audio?: string; // hex encoded
  };
  is_final?: boolean;
  trace_id?: string;
  base_resp?: {
    status_code: number;
    status_msg: string;
  };
}

// ============ 連線池 ============

interface PooledConnection {
  ws: WebSocket;
  /** 連線是否就緒（已收到 connected_success） */
  ready: boolean;
  /** 等待就緒的 resolver */
  readyResolve: (() => void) | null;
  /** 目前是否正在處理 task */
  busy: boolean;
  /** 目前 task 的回調 */
  currentTask: {
    textToSend: string;
    isEnglish: boolean;
    onAudioChunk: (chunk: Buffer) => void;
    onDone: () => void;
    onError: (error: string) => void;
    taskStarted: boolean;
    generation: number; // Fix 0E: 代數計數器
  } | null;
  /** Idle 超時計時器 */
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** 是否被 abort */
  aborted: boolean;
}

let pooledConn: PooledConnection | null = null;
const IDLE_TIMEOUT_MS = 90_000; // 90 秒 idle 後關閉（通話中用戶可能會停頓很久）

// Fix 0E: 代數計數器 — 防止 abort 後舊 task 的音頻污染新 task
let taskGeneration = 0;

/**
 * 取得或建立一個可用的 WebSocket 連線
 */
function getOrCreateConnection(): Promise<PooledConnection> {
  // 已有可用連線
  if (pooledConn && pooledConn.ws.readyState === WebSocket.OPEN && !pooledConn.aborted) {
    // 清除 idle timer
    if (pooledConn.idleTimer) {
      clearTimeout(pooledConn.idleTimer);
      pooledConn.idleTimer = null;
    }

    if (pooledConn.ready) {
      return Promise.resolve(pooledConn);
    }

    // 正在連線中，等待就緒
    return new Promise<PooledConnection>((resolve) => {
      pooledConn!.readyResolve = () => resolve(pooledConn!);
    });
  }

  // 需要建立新連線
  return createNewConnection();
}

function createNewConnection(): Promise<PooledConnection> {
  return new Promise<PooledConnection>((resolve, reject) => {
    const wsUrl = `wss://api.minimax.io/ws/v1/t2a_v2${config.minimaxGroupIdQuery}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'Authorization': `Bearer ${config.minimaxApiKey}`,
      },
    });

    const conn: PooledConnection = {
      ws,
      ready: false,
      readyResolve: null,
      busy: false,
      currentTask: null,
      idleTimer: null,
      aborted: false,
    };

    pooledConn = conn;

    ws.on('open', () => {
      console.log('[MiniMax-WS] 連線建立（pool）');
    });

    ws.on('message', (rawData) => {
      if (conn.aborted) return;

      try {
        const raw = rawData.toString();
        const msg: MinimaxWSMessage = JSON.parse(raw);

        // 連線就緒
        if (msg.event === 'connected_success') {
          conn.ready = true;
          console.log('[MiniMax-WS] connected_success, trace_id:', msg.trace_id || 'N/A');
          if (conn.readyResolve) {
            conn.readyResolve();
            conn.readyResolve = null;
          }
          resolve(conn);
          return;
        }

        // task_started → 發送文字
        if (msg.event === 'task_started' && conn.currentTask) {
          conn.currentTask.taskStarted = true;
          const task = conn.currentTask;
          const processedText = task.isEnglish ? task.textToSend : twToSp(task.textToSend);
          console.log(`[MiniMax-WS] task_started → sending text: "${processedText.slice(0, 40)}"`);

          ws.send(JSON.stringify({
            event: 'task_continue',
            text: processedText,
          }));
          ws.send(JSON.stringify({
            event: 'task_finish',
          }));
          return;
        }

        // 錯誤
        if (msg.base_resp && msg.base_resp.status_code !== 0) {
          console.error(`[MiniMax-WS] error response: code=${msg.base_resp.status_code} msg="${msg.base_resp.status_msg}"`);
          if (conn.currentTask) {
            conn.currentTask.onError(`MiniMax TTS 錯誤: ${msg.base_resp.status_msg}`);
            conn.currentTask = null;
            conn.busy = false;
            startIdleTimer(conn);
          }
          return;
        }

        // 音訊 chunk — Fix 0E: 比對代數，防止 abort 後舊 task 音頻污染新 task
        if (msg.data?.audio && conn.currentTask && conn.currentTask.generation === taskGeneration) {
          const bytes = Buffer.from(msg.data.audio, 'hex');
          if (bytes.length > 0) {
            conn.currentTask.onAudioChunk(bytes);
          }
        }

        // 最後一個 chunk → task 完成
        if (msg.is_final && conn.currentTask && conn.currentTask.generation === taskGeneration) {
          const task = conn.currentTask;
          conn.currentTask = null;
          conn.busy = false;
          console.log('[MiniMax-WS] task complete (is_final)');
          task.onDone();
          startIdleTimer(conn);
        }

        // 記錄未處理的 event
        if (msg.event && msg.event !== 'connected_success' && msg.event !== 'task_started' && !msg.data?.audio && !msg.is_final) {
          console.log(`[MiniMax-WS] unhandled event: "${msg.event}"`, raw.slice(0, 200));
        }
      } catch (err) {
        console.error('[MiniMax-WS] 訊息解析錯誤:', err, 'raw:', rawData.toString().slice(0, 200));
      }
    });

    ws.on('error', (err) => {
      console.error('[MiniMax-WS] 連線錯誤:', err.message);

      if (!conn.ready) {
        // 連線建立失敗
        reject(err);
        return;
      }

      if (conn.currentTask && !conn.aborted) {
        conn.currentTask.onError(`MiniMax WebSocket 連線錯誤: ${err.message}`);
        conn.currentTask = null;
        conn.busy = false;
      }

      // 錯誤後強制清除連線，讓下一個 task 建立新連線
      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      if (pooledConn === conn) pooledConn = null;
    });

    ws.on('close', (code, reason) => {
      console.log(`[MiniMax-WS] 連線關閉（pool）code=${code} reason="${reason?.toString() || ''}"`);

      if (conn.idleTimer) clearTimeout(conn.idleTimer);
      if (pooledConn === conn) pooledConn = null;

      // 如果有進行中的 task，回報錯誤
      if (conn.currentTask && !conn.aborted) {
        conn.currentTask.onError('MiniMax WebSocket 意外斷線');
        conn.currentTask = null;
      }
    });
  });
}

function startIdleTimer(conn: PooledConnection): void {
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  conn.idleTimer = setTimeout(() => {
    if (!conn.busy && conn.ws.readyState === WebSocket.OPEN) {
      console.log('[MiniMax-WS] Idle 超時，關閉連線');
      conn.ws.close();
    }
  }, IDLE_TIMEOUT_MS);
}

/**
 * 關閉連線池中的連線（通話結束時呼叫）
 */
export function closePooledConnection(): void {
  if (pooledConn) {
    pooledConn.aborted = true;
    if (pooledConn.idleTimer) clearTimeout(pooledConn.idleTimer);
    if (pooledConn.ws.readyState === WebSocket.OPEN) {
      pooledConn.ws.close();
    }
    pooledConn = null;
  }
}

// ============ 串流 TTS ============

/**
 * 用 MiniMax WebSocket 串流合成語音（連線池模式）
 *
 * 回傳 abort function，呼叫可中斷當前合成（打斷機制）
 */
export function streamTTS(options: MinimaxStreamOptions): { abort: () => void } {
  const { text, language = 'auto', onAudioChunk, onDone, onError } = options;

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

  // 非同步取得連線並啟動 task
  getOrCreateConnection()
    .then((conn) => {
      if (aborted) {
        onDone(); // 已被中斷，直接完成
        return;
      }

      conn.busy = true;
      const thisGeneration = ++taskGeneration; // Fix 0E: 新 task = 新代數
      conn.currentTask = {
        textToSend: text,
        isEnglish,
        onAudioChunk,
        onDone: () => {
          if (!aborted) onDone();
        },
        onError: (err) => {
          if (!aborted) onError(err);
        },
        taskStarted: false,
        generation: thisGeneration,
      };

      // 發送 task_start
      const taskStartPayload = {
        event: 'task_start',
        model: 'speech-2.8-turbo',  // 2026-06-12 升級 02 → 2.8
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
          format: 'mp3',
          channel: 1,
        },
      };
      console.log(`[MiniMax-WS] task_start: voice=${voiceId.slice(-8)} emotion=${emotion} text="${text.slice(0, 30)}" gen=${thisGeneration}`);
      conn.ws.send(JSON.stringify(taskStartPayload));
    })
    .catch((err) => {
      if (!aborted) {
        onError(`MiniMax WebSocket 建連失敗: ${err.message}`);
      }
    });

  // 回傳 abort function（打斷機制）
  return {
    abort: () => {
      aborted = true;
      // 中斷當前 task，但不關閉連線（連線可以復用）
      if (pooledConn?.currentTask) {
        pooledConn.currentTask = null;
        pooledConn.busy = false;
        startIdleTimer(pooledConn);
      }
    },
  };
}

// ============ 工具 ============

function isEnglishText(text: string): boolean {
  const englishChars = (text.match(/[a-zA-Z]/g) || []).length;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const totalLetters = englishChars + chineseChars;
  if (totalLetters === 0) return false;
  return englishChars / totalLetters > 0.85;
}
