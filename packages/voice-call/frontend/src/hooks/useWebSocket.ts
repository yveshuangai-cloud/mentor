/**
 * WebSocket Hook — LIFF 與後端的雙向通訊
 *
 * 協議：
 *   LIFF → 後端: call:start, audio:chunk, audio:interrupt, call:end
 *   後端 → LIFF: call:ready, audio:stream, audio:done, status, error, call:ended
 */

import { useRef, useState, useCallback, useEffect } from 'react';

// ============ 通訊協議 ============

export type CallStatus = 'idle' | 'connecting' | 'ringing' | 'active' | 'ended' | 'error';
// 2026-06-18 W2.3 — 加 'hearing' 區分「對方說話中」vs「對方靜默等待」
// listening = idle 等待對方開口
// hearing   = 對方正在說話（interim transcript 進來中）
// thinking  = 慢慢大腦處理中
// speaking  = 慢慢說話中
// interrupting = 打斷中（過渡狀態）
export type FelicityState = 'listening' | 'hearing' | 'thinking' | 'speaking' | 'interrupting';

interface ServerMessage {
  type: 'call:ready' | 'audio:segment' | 'audio:stream' | 'audio:done' | 'audio:clear' | 'audio:fadeout' | 'status' | 'error' | 'call:ended' | 'filler' | 'fx:tool' | 'location:request';
  greeting?: string;
  data?: string;       // base64 encoded audio
  state?: FelicityState;
  message?: string;
  index?: number;      // filler 音訊索引 (0-4)
  generation?: number;
  // fx:tool 事件用
  tool?: string;       // tool 名稱（search_memory / verify_my_memory / web_search 等）
  phase?: 'start' | 'done';
  // location:request 事件用（慢慢想知道你在哪 → 浮出同意卡）
  reason?: string;
}

interface UseWebSocketOptions {
  /** 後端 WebSocket URL（預設從環境變數） */
  url?: string;
  /** 收到 AI 音訊串流 */
  onAudioStream?: (audioData: ArrayBuffer) => void;
  /** 新的語音段落即將開始，用來標記實際播放首包 */
  onAudioSegment?: (generation: number) => void;
  /** AI 說完一段話了 */
  onAudioDone?: () => void;
  /** 🔧 強制清空音訊 buffer（投機 TTS 被取消時用，防止殘留音訊重疊） */
  onAudioClear?: () => void;
  /** 🎵 軟著陸：後端要求 fade-out（打斷時用） */
  onAudioFadeout?: () => void;
  /** 狀態變化 */
  onStatusChange?: (state: FelicityState) => void;
  /** 通話就緒（收到 greeting） */
  onReady?: (greeting: string) => void;
  /** 收到 filler 信號（播放「嗯...」） */
  onFiller?: (index: number) => void;
  /** 錯誤 */
  onError?: (message: string) => void;
  /** 通話結束 */
  onEnded?: () => void;
  /** 🔎 慢慢啟動 tool 時的音效信號（搜尋/驗證/web_search/翻命格）*/
  onToolUse?: (tool: string, phase: 'start' | 'done') => void;
  /** 📍 慢慢想知道你在哪 → 浮出同意卡 */
  onLocationRequest?: (reason?: string) => void;
}

export function useWebSocket(options: UseWebSocketOptions = {}) {
  const wsRef = useRef<WebSocket | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [felicityState, setFelicityState] = useState<FelicityState>('listening');

  // 用 ref 追蹤最新的 felicityState（避免 stale closure 讀到過時的值）
  const felicityStateRef = useRef<FelicityState>('listening');
  // 同步 ref 和 state 的 setter
  const updateFelicityState = useCallback((state: FelicityState) => {
    felicityStateRef.current = state;
    setFelicityState(state);
  }, []);

  // 用 ref 追蹤 callStatus（ws.onclose 的 stale closure 問題）
  const callStatusRef = useRef<CallStatus>('idle');
  const updateCallStatus = useCallback((status: CallStatus) => {
    callStatusRef.current = status;
    setCallStatus(status);
  }, []);

  // 建立 WebSocket 連線
  const connect = useCallback((token: string, sessionId: string) => {
    // 推導 WebSocket URL
    const wsUrl = options.url
      || import.meta.env.VITE_WS_URL as string
      || `${window.location.protocol === 'https:' ? 'wss:' : 'ws:'}//${window.location.host}/api/voice-call/ws`;

    const authenticatedUrl = new URL(wsUrl, window.location.href);
    authenticatedUrl.searchParams.set('token', token);

    updateCallStatus('connecting');

    const ws = new WebSocket(authenticatedUrl.toString());
    wsRef.current = ws;

    ws.binaryType = 'arraybuffer';

    // 🔧 QA-M8: 10 秒連線逾時，防止 WebSocket 掛起
    const connectTimeout = setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        console.warn('[WebSocket] 連線逾時 (10s)，關閉');
        ws.close();
        updateCallStatus('error');
        options.onError?.('連線逾時，請檢查網路後重試');
      }
    }, 10000);

    ws.onopen = () => {
      clearTimeout(connectTimeout);
      updateCallStatus('ringing');
      // 告訴後端：開始通話
      ws.send(JSON.stringify({
        type: 'call:start',
        sessionId,
      }));
    };

    ws.onmessage = (event) => {
      // 二進位 = 音訊串流
      if (event.data instanceof ArrayBuffer) {
        options.onAudioStream?.(event.data);
        return;
      }

      // JSON 訊息
      try {
        const msg: ServerMessage = JSON.parse(event.data as string);

        switch (msg.type) {
          case 'call:ready':
            updateCallStatus('active');
            options.onReady?.(msg.greeting || '');
            break;

          case 'audio:segment':
            if (Number.isInteger(msg.generation)) options.onAudioSegment?.(msg.generation!);
            break;

          case 'audio:stream':
            // base64 encoded audio fallback
            if (msg.data) {
              const binary = Uint8Array.from(atob(msg.data), c => c.charCodeAt(0));
              options.onAudioStream?.(binary.buffer);
            }
            break;

          case 'audio:done':
            options.onAudioDone?.();
            break;

          case 'audio:clear':
            // 🔧 強制清空：投機 TTS 被取消 / 新回覆開始前清空殘留音訊
            options.onAudioClear?.();
            break;

          case 'audio:fadeout':
            // 🎵 軟著陸：後端打斷時先 fade-out，不是立刻斷
            options.onAudioFadeout?.();
            break;

          case 'status':
            if (msg.state) {
              updateFelicityState(msg.state);
              options.onStatusChange?.(msg.state);
            }
            break;

          case 'filler':
            options.onFiller?.(msg.index ?? 0);
            break;

          case 'fx:tool':
            // 🔎 慢慢啟動 tool（search_memory / verify_my_memory / web_search / read_destiny 等）
            if (msg.tool && msg.phase) {
              options.onToolUse?.(msg.tool, msg.phase);
            }
            break;

          case 'location:request':
            // 📍 慢慢想知道你在哪 → 通知 App 浮出同意卡
            options.onLocationRequest?.(msg.reason);
            break;

          case 'error':
            updateCallStatus('error');
            options.onError?.(msg.message || '未知錯誤');
            break;

          case 'call:ended':
            updateCallStatus('ended');
            options.onEnded?.();
            break;
        }
      } catch {
        console.error('WebSocket: 無法解析訊息');
      }
    };

    ws.onerror = () => {
      clearTimeout(connectTimeout);
      updateCallStatus('error');
      options.onError?.('連線失敗');
    };

    ws.onclose = () => {
      clearTimeout(connectTimeout);
      if (callStatusRef.current !== 'ended' && callStatusRef.current !== 'error') {
        updateCallStatus('ended');
        options.onEnded?.();
      }
      wsRef.current = null;
    };
  }, [options, updateCallStatus, updateFelicityState]);

  // 發送音訊 chunk（PCM ArrayBuffer）
  const sendAudioChunk = useCallback((data: ArrayBuffer) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  }, []);

  // 發送打斷信號
  const sendInterrupt = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'audio:interrupt' }));
    }
  }, []);

  const sendPlaybackStarted = useCallback((generation: number) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'telemetry:playback-start', generation }));
    }
  }, []);

  // 掛斷
  const hangUp = useCallback(() => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'call:end' }));
    }
    updateCallStatus('ended');
    wsRef.current?.close();
    wsRef.current = null;
  }, []);

  // 組件卸載時清理
  useEffect(() => {
    return () => {
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, []);

  return {
    callStatus,
    felicityState,
    /** 用 ref 取得最新的 felicityState（避免 callback closure 中讀到過時值） */
    felicityStateRef,
    /** 手動更新 felicityState（例如前端偵測到插話時設為 interrupting） */
    updateFelicityState,
    connect,
    sendAudioChunk,
    sendInterrupt,
    sendPlaybackStarted,
    hangUp,
  };
}
