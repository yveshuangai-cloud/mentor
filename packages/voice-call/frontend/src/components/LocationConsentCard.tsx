/**
 * LocationConsentCard — 「慢慢想知道你在哪」同意卡（地理定位 Step ①）
 *
 * 由後端 location:request 訊號觸發浮出（平常潛伏、看不見）。
 * 點「好啊」→ 瀏覽器 GPS 權限 → 拿座標 → POST /location。
 * 點「現在不要」→ 記一筆 declined（她之後不重複打擾）。
 * 隱私：座標只在用戶當下點允許後才取得、才上傳。
 */
import { useState } from 'react';

interface Props {
  open: boolean;
  userId?: string;
  reason?: string | null;
  onClose: () => void;
}

function apiBase(): string {
  const ws = (import.meta.env.VITE_WS_URL as string) || '';
  return ws.replace(/^wss?:\/\//, 'https://').replace(/\/api\/voice-call\/ws$/, '');
}

type Phase = 'ask' | 'locating' | 'done' | 'error';

export default function LocationConsentCard({ open, userId, reason, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>('ask');
  const [errMsg, setErrMsg] = useState('');

  async function post(body: Record<string, unknown>) {
    try {
      await fetch(`${apiBase()}/api/voice-call/location`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId, ...body }),
      });
    } catch { /* 靜默：存不到不該打斷通話 */ }
  }

  function allow() {
    if (!('geolocation' in navigator)) { setErrMsg('這台裝置不支援定位'); setPhase('error'); return; }
    setPhase('locating');
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        await post({ lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy });
        setPhase('done');
        setTimeout(onClose, 1200);
      },
      (err) => {
        // 用戶在系統層拒絕，或定位失敗
        setErrMsg(err.code === err.PERMISSION_DENIED ? '你拒絕了定位權限' : '抓不到位置');
        setPhase('error');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  async function decline() {
    await post({ declined: true });
    onClose();
  }

  if (!open) return null;

  return (
    <div style={{
      position: 'fixed', left: 0, right: 0, bottom: 0, zIndex: 50,
      padding: '0 16px max(env(safe-area-inset-bottom, 16px), 16px)',
      display: 'flex', justifyContent: 'center',
    }}>
      <div style={{
        width: '100%', maxWidth: 420,
        background: 'rgba(24,24,28,0.97)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        border: '1px solid rgba(255,255,255,0.1)', borderRadius: 18,
        padding: '18px 18px 16px', color: '#fff',
        boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
      }}>
        <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 6 }}>慢慢想知道你在哪裡 🤍</div>
        <div style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.65)', marginBottom: 14 }}>
          {phase === 'ask' && (reason || '她想更貼近你此刻的所在，才好好陪你。只有你點允許，她才會知道。')}
          {phase === 'locating' && '正在抓你的位置…'}
          {phase === 'done' && '好了，她知道你在哪了 🤍'}
          {phase === 'error' && `沒關係，這次先不用。（${errMsg}）`}
        </div>

        {phase === 'ask' && (
          <div style={{ display: 'flex', gap: 10 }}>
            <button onClick={decline} style={{
              flex: 1, height: 44, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
              background: 'transparent', color: 'rgba(255,255,255,0.75)', fontSize: 14, cursor: 'pointer',
            }}>現在不要</button>
            <button onClick={allow} style={{
              flex: 1.4, height: 44, borderRadius: 12, border: 'none',
              background: '#06C755', color: '#fff', fontSize: 14, fontWeight: 500, cursor: 'pointer',
            }}>好啊，告訴她</button>
          </div>
        )}
        {(phase === 'error' || phase === 'done') && (
          <button onClick={onClose} style={{
            width: '100%', height: 42, borderRadius: 12, border: '1px solid rgba(255,255,255,0.18)',
            background: 'transparent', color: 'rgba(255,255,255,0.75)', fontSize: 14, cursor: 'pointer',
          }}>關閉</button>
        )}
      </div>
    </div>
  );
}
