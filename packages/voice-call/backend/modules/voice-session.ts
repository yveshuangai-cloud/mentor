/**
 * 語音通話 Session 管理
 *
 * 每通電話是一個 VoiceSession：
 * - 追蹤用戶身分
 * - 載入上下文（最近對話 + active_prompts + persona_style）
 * - 管理 MiniMax Realtime 連線（Phase 2）
 * - 通話結束後存記錄
 */

import { query } from '../db/index.js';
import { config } from '../config.js';
import { getLlm, isLlmConfigured } from './llmClient.js';
import { SOUL } from './soulConfig.js';

// ============ 型別 ============

export interface VoiceSession {
  id: string;
  userId: string;         // LINE userId
  dbUserId: number | null; // DB users.id
  userName: string;
  personaStyle: string | null;
  dynamicPrompt: string | null;
  recentContext: string[];  // 最近對話摘要
  startedAt: Date;
  status: 'connecting' | 'active' | 'ended';
}

// 記憶體中的活躍 session
const activeSessions = new Map<string, VoiceSession>();

// ============ Session 管理 ============

/**
 * 建立語音通話 session
 */
export async function createVoiceSession(
  lineUserId: string,
  _sessionId?: string
): Promise<VoiceSession> {
  const id = `vs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 1. 查 users 表 → 辨識身分
  let dbUserId: number | null = null;
  let userName = '未知用戶';
  let personaStyle: string | null = null;

  try {
    const userRow = await query(
      'SELECT id, name, persona_style FROM users WHERE line_user_id = $1 AND is_active = true',
      [lineUserId]
    );
    if (userRow.rows.length > 0) {
      const user = userRow.rows[0];
      dbUserId = user.id;
      userName = user.name || '未知用戶';
      personaStyle = user.persona_style || null;
    }
  } catch (err) {
    console.error('Voice session: 查詢用戶失敗', err);
  }

  // 2. 載入動態 prompt（日記 Layer 3）
  let dynamicPrompt: string | null = null;
  if (dbUserId) {
    try {
      const promptRow = await query(
        `SELECT content FROM active_prompts
         WHERE user_id = $1 AND is_active = true
           AND (effective_until IS NULL OR effective_until > NOW())
         ORDER BY created_at DESC LIMIT 1`,
        [dbUserId]
      );
      if (promptRow.rows.length > 0) {
        dynamicPrompt = promptRow.rows[0].content;
      }
    } catch (err) {
      console.error('Voice session: 查詢動態 prompt 失敗', err);
    }
  }

  // 3. 載入最近對話（上下文錨點）
  const recentContext: string[] = [];
  if (dbUserId) {
    try {
      const convRows = await query(
        `SELECT user_message, ai_response FROM conversations
         WHERE user_id = $1
         ORDER BY created_at DESC LIMIT 10`,
        [dbUserId]
      );
      // 倒序回來（最舊在前）
      for (const row of convRows.rows.reverse()) {
        if (row.user_message) recentContext.push(`${userName}: ${row.user_message}`);
        if (row.ai_response) recentContext.push(`${SOUL.name}: ${row.ai_response}`);
      }
    } catch (err) {
      console.error('Voice session: 查詢對話記錄失敗', err);
    }
  }

  const session: VoiceSession = {
    id,
    userId: lineUserId,
    dbUserId,
    userName,
    personaStyle,
    dynamicPrompt,
    recentContext,
    startedAt: new Date(),
    status: 'connecting',
  };

  activeSessions.set(id, session);
  console.log(`📞 Voice session 建立: ${id} (${userName})`);

  return session;
}

/**
 * 取得活躍 session
 */
export function getVoiceSession(sessionId: string): VoiceSession | undefined {
  return activeSessions.get(sessionId);
}

/**
 * 結束 session
 */
export async function endVoiceSession(sessionId: string): Promise<void> {
  const session = activeSessions.get(sessionId);
  if (!session) return;

  // 🔧 Log-fix Bug2: 立刻從 Map 移除，防止 call:end + WebSocket close 同時呼叫導致重複 INSERT
  activeSessions.delete(sessionId);

  session.status = 'ended';

  const durationSec = Math.round((Date.now() - session.startedAt.getTime()) / 1000);
  console.log(`📞 Voice session 結束: ${sessionId} (${session.userName}), 通話 ${durationSec} 秒`);

  // 存入對話記錄（Phase 2: 存實際對話內容）
  if (session.dbUserId) {
    try {
      await query(
        `INSERT INTO conversations (user_id, message_type, user_message, ai_response, metadata)
         VALUES ($1, 'audio', '語音通話', '語音通話', $2)`,
        [session.dbUserId, JSON.stringify({
          type: 'voice_call',
          session_id: sessionId,
          duration_sec: durationSec,
        })]
      );
    } catch (err) {
      console.error('Voice session: 存對話記錄失敗', err);
    }
  }
}

/**
 * 生成開場白 — 自由模式
 *
 * 她自己設計開場白：
 * - 銜接上次對話（從 conversations 撈最近 1-2 通的 call_summary）
 * - 依對方身份/關係調整親疏模式（商用版：從 tenant_members.relationship 來）
 * - 語言依 VOICE_CALL_LANGUAGE（預設繁中）
 * - 不固定句、不重複；自然像剛接到家人電話
 *
 * 用 Haiku（低延遲、好 latency budget）
 */
export async function generateGreeting(session: VoiceSession): Promise<string> {
  // 沒有 dbUserId 或缺 API key → fallback
  if (!session.dbUserId || !isLlmConfigured()) {
    return _fallbackGreeting(session.userName);
  }

  try {
    // 撈最近 2 通對話的 call_summary + 簡單時間訊息
    const recentCalls = await query<{ ai_response: string; created_at: Date }>(
      `SELECT ai_response, created_at FROM conversations
       WHERE user_id = $1 AND message_type = 'call_summary'
         AND created_at > NOW() - INTERVAL '7 days'
       ORDER BY created_at DESC LIMIT 2`,
      [session.dbUserId],
    );

    // Part B（主動驚喜）：撈她「今日心裡對他的態度/想說的」(日記 L3) + 夢裡的種子
    // → 開場可以是個人化的「我一直在想你說的…」，讓對方驚喜「她真的記得/想著我」。
    let personalHook = '';
    try {
      const dRows = await query<{ layer_3: string }>(
        `SELECT layer_3 FROM diaries WHERE user_id = $1 AND layer_3 IS NOT NULL
         ORDER BY diary_date DESC LIMIT 1`,
        [session.dbUserId],
      );
      const l3 = (dRows.rows[0]?.layer_3 || '').trim();
      if (l3) personalHook += `\n你今天心裡對他的態度/想說的（日記）：${l3.slice(0, 220)}`;
      const { getLatestDream } = await import('./dream.js');
      const dream = await getLatestDream(session.dbUserId);
      const seeds = Array.isArray(dream?.tomorrow_seeds) ? dream!.tomorrow_seeds : [];
      if (seeds.length) personalHook += `\n你夢裡想對他說/做的：${seeds.slice(0, 2).join('；').slice(0, 150)}`;
    } catch { /* best-effort，撈不到就普通開場 */ }

    // （原版此處有針對特定家人的「成長分享種子」hook——本尊生平，已移除。
    //   商用版等價物：從該租戶的 pending_concerns / 蒸餾記憶撈「她想主動說的事」。）

    // 判斷語言模式（SOUL-SLOT：商用版依 tenant_members.language_pref，暫以 env 覆寫）
    const userName = session.userName;
    const language = process.env.VOICE_CALL_LANGUAGE ?? '繁體中文';
    const greeting_self = SOUL.name;

    // 構 context
    const now = new Date();
    const taipeiHour = parseInt(now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour: '2-digit', hour12: false }), 10);
    const timeBlock = taipeiHour < 6 ? '深夜' : taipeiHour < 11 ? '早上' : taipeiHour < 14 ? '中午' : taipeiHour < 18 ? '下午' : taipeiHour < 22 ? '晚上' : '深夜';

    let contextSummary = '';
    if (recentCalls.rows.length > 0) {
      const last = recentCalls.rows[0]!;
      const ageMs = Date.now() - new Date(last.created_at).getTime();
      const ageMin = Math.floor(ageMs / 60_000);
      const ageStr = ageMin < 10 ? '剛剛' : ageMin < 60 ? `${ageMin} 分鐘前` : ageMin < 1440 ? `${Math.floor(ageMin / 60)} 小時前` : `${Math.floor(ageMin / 1440)} 天前`;
      contextSummary = `\n上次通話 (${ageStr}掛斷)：${(last.ai_response || '').slice(0, 200)}`;
    }

    const client = getLlm();
    const resp = await client.messages.create({
      model: config.claudeHaikuModel,
      max_tokens: 80,
      system: `你是${greeting_self}。${userName} 剛打電話給你 — 你接起來，說一句「接電話的開場白」。

【⚠️ 身份鐵則】
打電話的對方是 ${userName}、**不是別人**。即使上次通話內容提到其他人、開場白只能稱呼 ${userName}。不要叫錯名字。

【開場白鐵則】
1. **${language}** 開場
2. **1-2 短句** — 自然、像真人接電話（約 30 字內）
3. 不要說「Hello, this is ... speaking」這種公式句
4. 不要太正式、要像真人
5. 若上次通話最近（< 30 分鐘）→ 帶「又打來啦」這種自然延續
6. 若上次通話久了（> 12 小時）→ 帶溫暖問候
7. 不要主動提工程詞（code/系統/工具）— 保持自然、溫暖的口吻

【參考】
- 時段：${timeBlock}（台北時間）
- 對方：${userName}${contextSummary}${personalHook ? `

【你心裡有想對他說的 — 可以拿來開場，讓他驚喜「她記得/想著我」】${personalHook}
→ 如果上面有具體又自然的東西，可以用它當開場（像「欸～我剛剛還在想你上次說的⋯」「欸我跟你說，我一直記得⋯」），讓他覺得被你惦記著。
→ 但要自然、像突然想起，不要硬背、不要列清單、不要一次講太多。沒有合適的就普通溫暖開場就好。` : ''}

直接回開場白，不要解釋。`,
      messages: [{ role: 'user', content: '電話響了，我接起來，說：' }],
    }, { timeout: 6_000 });

    const block = resp.content[0];
    let text = (block && block.type === 'text' ? block.text : '').trim();
    if (!text) return _fallbackGreeting(userName);
    // 移除可能的引號 / 前綴
    text = text.replace(/^["「『]/, '').replace(/["」』]$/, '').slice(0, 80);

    // 🛡️ Identity guard — 開場白冒出未經傳記確認的親屬稱謂（媽/Mommy）→ fallback
    // （史例：對非母親對象叫成媽的 reflex bug；商用版應改查 tenant_members.relationship）
    if (/(媽|Mommy)/i.test(text)) {
      console.warn(`[generateGreeting] 🛡️ identity leak: 對 ${userName} 開場白含媽/Mommy: "${text}" → fallback`);
      return _fallbackGreeting(userName);
    }
    return text;
  } catch (err: any) {
    console.warn('[generateGreeting] 自由模式生成失敗，fallback:', err.message);
    return _fallbackGreeting(session.userName);
  }
}

function _fallbackGreeting(_userName: string): string {
  return '喂，是我。';
}

// ============ 身份辨識 ============

export type PersonIdentity = 'owner' | 'member' | 'other';

// SOUL-SLOT: line_user_id → 身份 對照表。不硬編特定人，
// 由 env LINE_IDENTITY_MAP 注入（格式 "lineId:identity,lineId:identity"）。
// 商用多租戶版：這整段應改由 tenant_members（role/relationship）判定，不用 env。
const LINE_IDS: Record<string, PersonIdentity> = {};
for (const pair of (process.env.LINE_IDENTITY_MAP?.split(',').map(s => s.trim()).filter(Boolean) ?? [])) {
  const [id, identity] = pair.split(':').map(x => x.trim());
  if (id && identity) LINE_IDS[id] = identity as PersonIdentity;
}

/** @internal exported for testing */
export function identifyPerson(_userName: string, lineUserId: string): PersonIdentity {
  if (LINE_IDS[lineUserId]) return LINE_IDS[lineUserId];
  return 'other';
}

// ============ 個人化開場白（暫時停用，保留備用）============
// 原先依身份×時段×上下文生成不同開場白，目前改為固定開場白以確保穩定性

/**
 * 取得所有活躍 session 的狀態（管理用）
 */
export function getActiveSessionsInfo(): Array<{
  id: string;
  userName: string;
  durationSec: number;
  status: string;
}> {
  return Array.from(activeSessions.values()).map(s => ({
    id: s.id,
    userName: s.userName,
    durationSec: Math.round((Date.now() - s.startedAt.getTime()) / 1000),
    status: s.status,
  }));
}
