/**
 * 🚦 HealthIndicator — 頂部 5 個服務健康燈
 *
 * 設計指示：智能 / 記憶 / 聽聲 / 發聲 / 收音 5 顆燈
 * 綠燈 = 健康、紅燈 = 斷線
 *
 * 4 個從後端 GET /api/voice-call/health/services 拉
 * 1 個（收音）從本地 micActive / micError 判斷
 */

import { useEffect, useState } from 'react';

interface HealthIndicatorProps {
  /** 收音狀態 — 從 useAudio 來 */
  micActive: boolean;
  micError: string | null;
}

interface ServiceStatus {
  ok: boolean;
  note?: string;
}

interface HealthData {
  intelligence: ServiceStatus;
  memory: ServiceStatus;
  hearing: ServiceStatus;
  speaking: ServiceStatus;
}

const INITIAL: HealthData = {
  intelligence: { ok: false },
  memory: { ok: false },
  hearing: { ok: false },
  speaking: { ok: false },
};

export default function HealthIndicator({ micActive, micError }: HealthIndicatorProps) {
  const [health, setHealth] = useState<HealthData>(INITIAL);
  const [lastUpdate, setLastUpdate] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;

    // LiFF 部署在 Cloudflare Pages、後端在另一個 domain — 必須用絕對 URL
    // 從 VITE_WS_URL (wss://{{PUBLIC_DOMAIN}}/api/voice-call/ws) 推導
    const wsUrl = import.meta.env.VITE_WS_URL as string | undefined;
    let backendBase = '';
    if (wsUrl) {
      try {
        const u = new URL(wsUrl);
        backendBase = `${u.protocol === 'wss:' ? 'https:' : 'http:'}//${u.host}`;
      } catch {}
    }

    async function poll() {
      try {
        const url = `${backendBase}/api/webhook/health/services`;
        const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (cancelled) return;
        if (data.services) {
          setHealth(data.services);
          setLastUpdate(Date.now());
        }
      } catch {
        // 後端 fetch 失敗 → 全紅
        if (cancelled) return;
        setHealth({
          intelligence: { ok: false, note: 'backend unreachable' },
          memory: { ok: false, note: 'backend unreachable' },
          hearing: { ok: false, note: 'backend unreachable' },
          speaking: { ok: false, note: 'backend unreachable' },
        });
      }
    }

    poll();
    const interval = setInterval(poll, 15_000);  // 每 15 秒檢查
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, []);

  // 收音狀態：micActive=true && 沒 error → 綠；否則紅
  const micOk = micActive && !micError;

  const lights: Array<{ label: string; ok: boolean; note?: string }> = [
    { label: '智能', ok: health.intelligence.ok, note: health.intelligence.note },
    { label: '記憶', ok: health.memory.ok, note: health.memory.note },
    { label: '聽聲', ok: health.hearing.ok, note: health.hearing.note },
    { label: '發聲', ok: health.speaking.ok, note: health.speaking.note },
    { label: '收音', ok: micOk, note: micError || undefined },
  ];

  const ageS = lastUpdate ? Math.floor((Date.now() - lastUpdate) / 1000) : null;
  const stale = ageS !== null && ageS > 30;

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-black/30 backdrop-blur-sm">
      {lights.map((light, i) => (
        <div key={i} className="flex items-center gap-1" title={light.note || (light.ok ? '正常' : '斷線')}>
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              light.ok
                ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.6)]'
                : 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.6)]'
            } ${stale && !light.ok ? 'animate-pulse' : ''}`}
          />
          <span className="text-[10px] text-white/70 font-light tracking-wider whitespace-nowrap">
            {light.label}
          </span>
        </div>
      ))}
    </div>
  );
}
