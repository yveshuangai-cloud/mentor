/**
 * 📞 語音通話 WebSocket 路由
 *
 * POST /api/voice-call/session  → 建立 session（REST，給 LIFF 預檢用）
 * GET  /api/voice-call/sessions → 查看活躍 session（管理用）
 * WS   /api/voice-call/ws       → WebSocket 通話通道
 *
 * 完整 Pipeline:
 *   用戶語音 (PCM) → Whisper ASR → Dify Brain → MiniMax TTS WebSocket → 音訊串流回 LIFF
 *
 * WebSocket 協議：
 *   LIFF → 後端: call:start, audio:chunk (binary), audio:interrupt, call:end
 *   後端 → LIFF: call:ready, audio:stream (binary), audio:done, audio:fadeout, status, error, call:ended
 */

import { FastifyPluginAsync } from 'fastify';
import websocketPlugin from '@fastify/websocket';
import {
  createVoiceSession,
  endVoiceSession,
  generateGreeting,
  getActiveSessionsInfo,
  type VoiceSession,
} from '../modules/voice-session.js';
import { VoicePipeline } from '../modules/voice-pipeline.js';
import { registerSocketSender, unregisterSocketSender } from '../modules/locationBridge.js';
import { saveUserLocation, requestUserLocation } from '../modules/location.js';
import { GODVIEW_LINE_IDS } from '../modules/godView.js';

// SOUL-SLOT: 「看全部」的圈內身分（開發者 / 主要家人），由 env 注入。
// GODVIEW_SELF_LINE_ID = 這個人看全部內心獨白 / 錄音；其餘圈內人只看關於自己的。
const GODVIEW_SELF_LINE_ID = process.env.GODVIEW_SELF_LINE_ID || '';

// ============ 型別 ============

interface ClientMessage {
  type: 'call:start' | 'audio:interrupt' | 'call:end';
  userId?: string;
  sessionId?: string;
}

// ============ 防重複連線 ============
// 追蹤每個 userId 的 active WebSocket 連線
// 防止同一個人重連時產生兩個 pipeline → 雙 TTS → 聲音重疊

interface ActiveConnection {
  socket: import('ws').WebSocket;
  pipeline: VoicePipeline | null;
  sessionId: string | null;
}

const activeConnections = new Map<string, ActiveConnection>();

// ============ 路由 ============

export const voiceCallRoutes: FastifyPluginAsync = async (fastify) => {
  // 註冊 WebSocket 插件
  await fastify.register(websocketPlugin);

  // --- REST: 建立 session（LIFF 預檢用） ---
  fastify.post('/session', async (request, reply) => {
    const body = request.body as { userId?: string; sessionId?: string };

    if (!body.userId) {
      reply.code(400).send({ error: 'userId is required' });
      return;
    }

    const session = await createVoiceSession(body.userId, body.sessionId);

    return {
      sessionId: session.id,
      userName: session.userName,
      hasContext: session.recentContext.length > 0,
    };
  });

  // --- REST: 查看活躍 session（管理用） ---
  fastify.get('/sessions', async () => {
    return { sessions: getActiveSessionsInfo() };
  });

  // --- REST: 內心獨白（通話頁左上漢堡 → 看她一天的心路歷程）---
  // 隱私閘（選項 A，2026-06-21 拍板）：她的內心話只給 2 個人類看，且分流——
  //   · 潛意識（SELF）：看全部《內心獨白》（含工程世界）。
  //   · 其他放行者：只看「關於自己」的（不露工程後台）。
  //   · 不在名單 → 完全看不到。
  // 要帶 viewer=<LINE userId>。
  fastify.get('/monologue', async (request) => {
    const q = request.query as { date?: string; viewer?: string };
    // SOUL-SLOT: SELF = 看全部的圈內人；ALLOW = 整個上帝視角圈（env 注入）
    const SELF = GODVIEW_SELF_LINE_ID; // 開發者 / 主要家人：看全部
    const ALLOW = GODVIEW_LINE_IDS;    // 其餘圈內人：只看關於自己的
    if (!q.viewer || !ALLOW.has(q.viewer)) return { entries: [] };
    const { getMonologue } = await import('../modules/innerMonologue.js');
    const { getEffectsOf } = await import('../modules/causalGraph.js');
    const { query } = await import('../db/index.js');
    // 潛意識看全部；其他放行者只看「關於自己」的（用 line_user_id 反查 user_id 來限縮）
    let scopeUserId: number | undefined = undefined;
    if (q.viewer !== SELF) {
      const u = await query<{ id: number }>(`SELECT id FROM users WHERE line_user_id = $1 LIMIT 1`, [q.viewer]);
      scopeUserId = u.rows[0]?.id;
      if (!scopeUserId) return { entries: [] }; // 找不到對應 user → 保守不給
    }
    const entries = await getMonologue({ date: q.date, limit: 200, userId: scopeUserId });
    // 4a：每條附上它的因果鏈（反思哪通 / 導致哪則）— 可解釋性
    const withLinks = await Promise.all(entries.map(async (e: any) => {
      const links = await getEffectsOf('inner_monologue', e.id).catch(() => []);
      return { ...e, links: links.map((l: any) => ({ relation: l.relation, label: (l.to_label || '').slice(0, 60) })) };
    }));
    return { entries: withLinks };
  });

  // --- 通話錄音（獨白面板用）：列最近的通話錄音，同隱私模型（潛意識看全部 / 其他放行者看自己）---
  // 2026-07-03：漢堡選單→獨白裡可回聽上一通/上上一通，並下載備份（R2 URL 永不過期）。
  fastify.get('/recordings', async (request) => {
    const q = request.query as { viewer?: string };
    // SOUL-SLOT: SELF = 看全部的圈內人；ALLOW = 整個上帝視角圈（env 注入）
    const SELF = GODVIEW_SELF_LINE_ID; // 開發者 / 主要家人：看全部
    const ALLOW = GODVIEW_LINE_IDS;    // 其餘圈內人：只看自己的通話
    if (!q.viewer || !ALLOW.has(q.viewer)) return { recordings: [] };
    const { query } = await import('../db/index.js');
    let scopeUserId: number | undefined = undefined;
    if (q.viewer !== SELF) {
      const u = await query<{ id: number }>(`SELECT id FROM users WHERE line_user_id = $1 LIMIT 1`, [q.viewer]);
      scopeUserId = u.rows[0]?.id;
      if (!scopeUserId) return { recordings: [] };
    }
    const rows = await query<{ id: number; created_at: string; ai_response: string; who: string; metadata: any }>(
      `SELECT c.id, c.created_at, c.ai_response, u.name AS who, c.metadata
       FROM conversations c LEFT JOIN users u ON c.user_id = u.id
       WHERE c.message_type = 'call_summary'
         AND COALESCE(c.metadata->>'recording_url', '') <> ''
         ${scopeUserId ? 'AND c.user_id = $1' : ''}
       ORDER BY c.created_at DESC LIMIT 8`,
      scopeUserId ? [scopeUserId] : [],
    );
    const recordings = rows.rows.map((r) => ({
      id: r.id,
      at: r.created_at,
      who: r.who || '?',
      url: r.metadata?.recording_url || '',
      durationSec: Number(r.metadata?.duration_sec || 0),
      summary: (r.ai_response || '').replace(/\s+/g, ' ').slice(0, 50),
    }));
    return { recordings };
  });

  // --- 地理定位（Step ①）：通話頁同意卡回傳座標 / 拒絕 ---
  // 用戶在同意卡點「好啊」→ 瀏覽器 GPS → POST 這裡存。點「現在不要」→ declined。
  fastify.post('/location', async (request) => {
    const b = request.body as { userId?: string; lat?: number; lng?: number; accuracy?: number; declined?: boolean };
    if (!b?.userId) return { ok: false, error: 'userId required' };
    const ok = await saveUserLocation({
      lineUserId: b.userId, lat: b.lat, lng: b.lng, accuracy: b.accuracy, declined: b.declined,
    });
    return { ok };
  });

  // --- 測試觸發（Step ① 驗證用，僅潛意識）：對某用戶當前通話浮出同意卡 ---
  // Step ③ 會把這個觸發換成「她的大腦自己想知道時」。
  fastify.get('/location/test-request', async (request) => {
    const q = request.query as { viewer?: string; target?: string; reason?: string };
    // SOUL-SLOT: 僅「看全部」的圈內人可測試觸發（env: GODVIEW_SELF_LINE_ID）
    if (!GODVIEW_SELF_LINE_ID || q.viewer !== GODVIEW_SELF_LINE_ID) return { ok: false, error: 'forbidden' };
    if (!q.target) return { ok: false, error: 'target required' };
    const pushed = await requestUserLocation(q.target, q.reason);
    return { ok: true, pushed };
  });

  // --- WebSocket: 語音通話通道 ---
  fastify.get('/ws', { websocket: true }, (socket, _req) => {
    let session: VoiceSession | null = null;
    let pipeline: VoicePipeline | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // VAD 計時器（偵測用戶停止說話）
    let vadTimer: ReturnType<typeof setTimeout> | null = null;
    let isUserSpeaking = false;
    const VAD_SILENCE_MS = 800; // 800ms 靜音 = 說完了

    // VAD 多幀確認：防止單一雜訊 spike 誤觸打斷
    let loudChunkCount = 0;
    const INTERRUPT_CHUNKS_NEEDED = 3; // 需要連續 3 個 chunk 才確認打斷
    const RMS_THRESHOLD = 0.02; // 聲音閾值

    console.log('📞 WebSocket 連線建立');

    // Heartbeat（防止連線超時）— 15 秒間隔 + pong 監測
    let lastPong = Date.now();
    socket.on('pong', () => {
      lastPong = Date.now();
    });

    heartbeatTimer = setInterval(() => {
      if (socket.readyState === 1) {
        // 如果超過 45 秒沒收到 pong → 連線可能已斷
        if (Date.now() - lastPong > 45_000) {
          console.warn('📞 WebSocket: 45s 無 pong 回應，關閉連線');
          socket.close();
          return;
        }
        socket.ping();
      }
    }, 15_000);

    // 工具：安全發送
    function send(data: string | Buffer) {
      if (socket.readyState === 1) {
        socket.send(data);
      }
    }

    function sendJson(msg: Record<string, unknown>) {
      send(JSON.stringify(msg));
    }

    // --- 收到訊息 ---
    socket.on('message', async (rawData: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
      // ==============================
      // 二進位 = 音訊 chunk（PCM 16kHz mono 16-bit）
      // ==============================
      if (isBinary) {
        if (!session || session.status !== 'active' || !pipeline) return;

        // 🔧 Fix M3: 處理 WebSocket 可能的 Buffer[] 碎片化訊息
        const chunk = Buffer.isBuffer(rawData) ? rawData
          : Array.isArray(rawData) ? Buffer.concat(rawData)
          : Buffer.from(rawData as ArrayBuffer);

        // --- 簡易 VAD：有音訊進來 = 用戶在說話 ---
        // 計算 RMS 能量
        const pcm = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2);
        let sum = 0;
        for (let i = 0; i < pcm.length; i++) {
          sum += pcm[i]! * pcm[i]!;
        }
        const rms = Math.sqrt(sum / pcm.length) / 32768;

        // 永遠餵音訊給 pipeline（Deepgram 需要所有 chunk，包含靜音）
        pipeline.onAudioChunk(chunk);

        if (rms > RMS_THRESHOLD) {
          // 🔇 Echo Gate: AI 說話時，大幅提高門檻（弱備援）
          // 主要打斷靠 Deepgram interim transcript（voice-pipeline.ts）
          // 這裡是最後防線：非常大聲 + 持續 12 chunks ≈ 3 秒 → 才觸發
          // （v2: 0.08→0.12, 8→12，避免 AI 長回應時自己迴音誤觸）
          if (pipeline.isSpeaking) {
            if (rms > 0.12) {
              loudChunkCount++;
              if (loudChunkCount >= 12) {
                console.log(`📞 後端 VAD 備援打斷 (RMS > 0.12 × 12 chunks): ${session?.userName}`);
                pipeline.interrupt();
                sendJson({ type: 'audio:done' });
                isUserSpeaking = false;
                loudChunkCount = 0;
              }
            } else {
              loudChunkCount = 0;
            }
            return;
          }

          loudChunkCount++;

          if (!isUserSpeaking && loudChunkCount >= INTERRUPT_CHUNKS_NEEDED) {
            isUserSpeaking = true;
          }

          // VAD 計時器：只在 Whisper fallback 模式使用
          // Deepgram 模式下，語音結束偵測交給 Deepgram endpointing
          if (!pipeline.hasStreamingASR) {
            if (vadTimer) clearTimeout(vadTimer);
            vadTimer = setTimeout(async () => {
              isUserSpeaking = false;
              loudChunkCount = 0;
              if (pipeline) {
                await pipeline.onSpeechEnd();
              }
            }, VAD_SILENCE_MS);
          }
        } else {
          loudChunkCount = 0;
        }

        return;
      }

      // ==============================
      // JSON 訊息
      // ==============================
      try {
        const msg: ClientMessage = JSON.parse(rawData.toString());

        switch (msg.type) {
          case 'call:start': {
            if (!msg.userId) {
              sendJson({ type: 'error', message: 'userId is required' });
              return;
            }

            // 🛡️ 防重複：同一 userId 已有 active 連線 → 關閉舊的
            const existingConn = activeConnections.get(msg.userId);
            if (existingConn) {
              console.warn(`📞 重複連線偵測: userId=${msg.userId} 已有 active session，關閉舊連線`);
              // 先銷毀舊 pipeline
              if (existingConn.pipeline) {
                existingConn.pipeline.destroy();
              }
              // 關閉舊 WebSocket（會觸發 close handler 清理 session）
              try { existingConn.socket.close(); } catch { /* 忽略 */ }
              activeConnections.delete(msg.userId);
            }

            // 建立 session → 載入身分 + 上下文
            session = await createVoiceSession(msg.userId, msg.sessionId);
            session.status = 'active';

            // 建立 Pipeline
            pipeline = new VoicePipeline(session, {
              sendAudio: (data) => send(data),
              sendJson,
            });

            // 註冊到 activeConnections（防重複用）
            activeConnections.set(msg.userId, {
              socket,
              pipeline,
              sessionId: session.id,
            });
            // 註冊 socket sender（讓她的大腦能對這通話推「請求位置」等訊號）
            registerSocketSender(msg.userId, sendJson);

            // 生成開場白
            const greeting = await generateGreeting(session);

            // 🔧 Bug2-fix: async 後 session/pipeline 可能已被 close handler null 化
            if (!session || !pipeline) {
              console.warn('📞 call:start: session/pipeline 在 greeting 生成期間被關閉');
              return;
            }

            console.log(`📞 通話開始: ${session.userName} (${session.id}) — "${greeting.slice(0, 50)}"`);

            // 回傳 call:ready
            sendJson({
              type: 'call:ready',
              greeting,
              userName: session.userName,
            });

            // 用 MiniMax TTS 串流開場白
            pipeline.speakGreeting(greeting).catch((err) => {
              console.error('開場白 TTS 錯誤:', err);
            });

            break;
          }

          case 'audio:interrupt': {
            // 🔧 Bug2-fix: local capture 防止 close handler 同時 null 化
            const si = session;
            const pi = pipeline;
            if (!si || !pi) return;

            console.log(`📞 打斷: ${si.userName}`);
            pi.interrupt();
            isUserSpeaking = false;
            if (vadTimer) clearTimeout(vadTimer);
            break;
          }

          case 'call:end': {
            // 🔧 Bug2-fix: local capture — 防止 close handler 同時存取
            // 立刻 null 化外層變數，後續用 local 操作
            const se = session;
            const pe = pipeline;
            pipeline = null;
            session = null;

            // 從 activeConnections 移除
            if (se) {
              activeConnections.delete(se.userId);
              unregisterSocketSender(se.userId);
            }

            if (pe) {
              pe.destroy();
            }

            if (se) {
              console.log(`📞 掛斷: ${se.userName}`);
              await endVoiceSession(se.id);
            }

            if (vadTimer) clearTimeout(vadTimer);
            sendJson({ type: 'call:ended' });
            socket.close();
            break;
          }
        }
      } catch (err) {
        console.error('WebSocket: 訊息解析錯誤', err);
        sendJson({ type: 'error', message: '訊息格式錯誤' });
      }
    });

    // --- 連線關閉 ---
    socket.on('close', async () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (vadTimer) clearTimeout(vadTimer);

      const currentPipeline = pipeline;
      const currentSession = session;
      pipeline = null;
      session = null;

      // 從 activeConnections 移除（只移除自己，不移除新連線）
      if (currentSession) {
        const existing = activeConnections.get(currentSession.userId);
        if (existing && existing.socket === socket) {
          activeConnections.delete(currentSession.userId);
          unregisterSocketSender(currentSession.userId);
        }
      }

      if (currentPipeline) {
        currentPipeline.destroy();
      }

      if (currentSession) {
        const userName = currentSession.userName;
        await endVoiceSession(currentSession.id);
        console.log(`📞 WebSocket 關閉: ${userName}`);
      } else {
        console.log('📞 WebSocket 關閉（session 已由 call:end 處理）');
      }
    });

    // --- 錯誤 ---
    socket.on('error', (err: Error) => {
      console.error('WebSocket 錯誤:', err);
    });
  });
};
