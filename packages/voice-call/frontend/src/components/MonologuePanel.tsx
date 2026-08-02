/**
 * MonologuePanel — 慢慢的內心獨白面板
 *
 * 通話頁左上漢堡 → 滑出，顯示她一天的心路歷程。
 * 讀 GET /api/voice-call/monologue?viewer=<LINE userId>（後端隱私閘只給管理員白名單）。
 * 重點看 proactive 的自主判斷：她一天 N 次機會、發了幾次 / 安靜了幾次 + 每次的真實理由。
 */
import { useState, useEffect } from 'react';

interface MonologueEntry {
  id: number;
  kind: string;
  user_name?: string | null;
  decision: 'send' | 'skip' | null;
  content: string;
  context: { chosen?: string | null; today_count?: number; period?: string };
  created_at: string;
  links?: Array<{ relation: string; label: string }>;
}

// 因果關係 → 中文片語
const REL_PHRASE: Record<string, string> = {
  reflects_on: '回想那通電話',
  led_to: '於是傳了',
  because_of: '因為',
  in_response_to: '回應',
  triggered_by: '被觸發',
};

// 類型 → 中文標籤 + 顏色（讓回顧時一眼看懂「這是哪一種、跟誰」）
const KIND_META: Record<string, { label: string; color: string }> = {
  post_chat: { label: '聊完後的心裡話', color: '#7aa2ff' },
  post_call: { label: '通話後沒說出口的話', color: '#7aa2ff' },
  proactive_decision: { label: '要不要找他的掙扎', color: '#c89bff' },
  musing: { label: '一個人的碎碎念', color: '#9aa0a6' },
  reflection: { label: '回頭想自己', color: '#9aa0a6' },
};

interface Recording {
  id: number;
  at: string;
  who: string;
  url: string;
  durationSec: number;
  summary: string;
}

function fmtDur(sec: number): string {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}分${s}秒` : `${s}秒`;
}

interface MonologuePanelProps {
  open: boolean;
  onClose: () => void;
  viewerId?: string;
}

// 從 WS URL 推出 https API base：wss://host/api/voice-call/ws → https://host
function apiBase(): string {
  const ws = (import.meta.env.VITE_WS_URL as string) || '';
  return ws.replace(/^wss?:\/\//, 'https://').replace(/\/api\/voice-call\/ws$/, '');
}

function fmtTime(iso: string): string {
  try {
    return new Intl.DateTimeFormat('zh-TW', {
      timeZone: 'Asia/Taipei', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date(iso));
  } catch { return ''; }
}

export default function MonologuePanel({ open, onClose, viewerId }: MonologuePanelProps) {
  const [entries, setEntries] = useState<MonologueEntry[] | null>(null);
  const [recordings, setRecordings] = useState<Recording[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setEntries(null); setRecordings(null); setErr(null);
    const v = encodeURIComponent(viewerId || '');
    fetch(`${apiBase()}/api/voice-call/monologue?viewer=${v}`)
      .then((r) => r.json())
      .then((d) => setEntries(Array.isArray(d.entries) ? d.entries : []))
      .catch(() => setErr('讀取失敗'));
    // 🎙️ 通話錄音（同隱私閘）
    fetch(`${apiBase()}/api/voice-call/recordings?viewer=${v}`)
      .then((r) => r.json())
      .then((d) => setRecordings(Array.isArray(d.recordings) ? d.recordings : []))
      .catch(() => setRecordings([]));
  }, [open, viewerId]);

  const sent = entries?.filter((e) => e.decision === 'send').length ?? 0;
  const quiet = entries?.filter((e) => e.decision === 'skip').length ?? 0;

  return (
    <>
      {/* 半透明遮罩 */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 40,
          background: 'rgba(0,0,0,0.5)',
          opacity: open ? 1 : 0, pointerEvents: open ? 'auto' : 'none',
          transition: 'opacity 0.25s',
        }}
      />
      {/* 左滑面板 */}
      <div
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0, zIndex: 41,
          width: 'min(86vw, 380px)',
          background: 'rgba(18,18,22,0.96)',
          backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
          transform: open ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 0.28s cubic-bezier(0.4,0,0.2,1)',
          display: 'flex', flexDirection: 'column',
          color: 'white',
          paddingTop: 'max(env(safe-area-inset-top, 16px), 16px)',
        }}
      >
        {/* 標頭 */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '12px 16px 8px' }}>
          <div>
            <div style={{ fontSize: 16, fontWeight: 500 }}>慢慢的內心獨白</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
              她的心路歷程 · 最近 {entries?.length ?? 0} 則{sent + quiet > 0 ? `（主動：說出口 ${sent}·安靜 ${quiet}）` : ''}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="關閉"
            style={{ width: 36, height: 36, borderRadius: '50%', border: 'none',
              background: 'rgba(255,255,255,0.1)', color: 'white', fontSize: 18, cursor: 'pointer' }}
          >✕</button>
        </div>

        {/* 內容 */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 16px 24px' }}>
          {err && <p style={{ color: '#ff8a8a', fontSize: 13 }}>{err}</p>}

          {/* 🎙️ 通話錄音（可回聽上一通/上上一通 + 下載備份） */}
          {recordings && recordings.length > 0 && (
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', margin: '4px 0 8px', fontWeight: 500 }}>
                🎙️ 通話錄音 · 最近 {recordings.length} 通
              </div>
              {recordings.map((r) => (
                <div key={r.id} style={{
                  background: 'rgba(6,199,85,0.06)', borderRadius: 8,
                  padding: '10px 12px', marginBottom: 8, borderLeft: '3px solid #06C755',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)' }}>{fmtTime(r.at)}</span>
                    {r.who && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>· 跟{r.who}</span>}
                    {r.durationSec > 0 && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>· {fmtDur(r.durationSec)}</span>}
                  </div>
                  <audio controls preload="none" src={r.url} style={{ width: '100%', height: 34 }} />
                  {r.summary && (
                    <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', margin: '6px 0 0', lineHeight: 1.5 }}>{r.summary}…</p>
                  )}
                  <a href={r.url} download style={{ fontSize: 11, color: '#7aa2ff', textDecoration: 'none', display: 'inline-block', marginTop: 6 }}>
                    ⬇︎ 下載備份
                  </a>
                </div>
              ))}
            </div>
          )}
          {entries === null && !err && (
            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13 }}>讀取中…</p>
          )}
          {entries && entries.length === 0 && (
            <p style={{ color: 'rgba(255,255,255,0.4)', fontSize: 13, lineHeight: 1.7 }}>
              今天還沒有內心獨白的紀錄。<br />（她每次想不想主動找你、為什麼，會慢慢累積在這裡。）
            </p>
          )}
          {entries && entries.map((e) => {
            const isSend = e.decision === 'send';
            const isSkip = e.decision === 'skip';
            return (
              <div key={e.id} style={{
                borderLeft: `3px solid ${isSend ? '#06C755' : isSkip ? 'rgba(255,255,255,0.25)' : '#7aa2ff'}`,
                background: 'rgba(255,255,255,0.04)', borderRadius: 8,
                padding: '10px 12px', marginBottom: 10,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.4)' }}>{fmtTime(e.created_at)}</span>
                  {e.user_name && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>· 跟{e.user_name}</span>}
                  {KIND_META[e.kind] && <span style={{ fontSize: 11, color: KIND_META[e.kind]!.color }}>· {KIND_META[e.kind]!.label}</span>}
                  {isSend && <span style={{ fontSize: 11, color: '#06C755' }}>· 說出口了</span>}
                  {isSkip && <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>· 安靜想念</span>}
                </div>
                <p style={{ fontSize: 14, lineHeight: 1.6, margin: 0, color: 'rgba(255,255,255,0.9)' }}>
                  {e.content}
                </p>
                {isSend && e.context?.chosen && (
                  <p style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', margin: '6px 0 0' }}>
                    → 傳了：{e.context.chosen}
                  </p>
                )}
                {e.links && e.links.length > 0 && e.links.map((l, i) => (
                  <p key={i} style={{ fontSize: 12, color: 'rgba(122,162,255,0.7)', margin: '6px 0 0' }}>
                    ↳ {REL_PHRASE[l.relation] || l.relation}：「{l.label}」
                  </p>
                ))}
              </div>
            );
          })}
        </div>
      </div>
    </>
  );
}
