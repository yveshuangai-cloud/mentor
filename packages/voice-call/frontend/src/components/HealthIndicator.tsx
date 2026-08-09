import { useEffect, useState } from 'react';

interface HealthIndicatorProps {
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
  livekit: ServiceStatus;
}

const unchecked = { ok: false, note: '尚未檢查' };
const INITIAL: HealthData = {
  intelligence: unchecked,
  memory: unchecked,
  hearing: unchecked,
  speaking: unchecked,
  livekit: unchecked,
};

export default function HealthIndicator({ micActive, micError }: HealthIndicatorProps) {
  const [health, setHealth] = useState<HealthData>(INITIAL);
  const [lastUpdate, setLastUpdate] = useState(0);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const response = await fetch('/api/voice-call/health/services', {
          cache: 'no-store',
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { services?: HealthData };
        if (!cancelled && data.services) {
          setHealth(data.services);
          setLastUpdate(Date.now());
        }
      } catch {
        if (!cancelled) {
          const unavailable = { ok: false, note: '健康檢查目前無法連線' };
          setHealth({
            intelligence: unavailable,
            memory: unavailable,
            hearing: unavailable,
            speaking: unavailable,
            livekit: unavailable,
          });
        }
      }
    }

    void poll();
    const interval = window.setInterval(() => void poll(), 15_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  const lights = [
    { label: '思考', ...health.intelligence },
    { label: '記憶', ...health.memory },
    { label: '聽力', ...health.hearing },
    { label: '聲音', ...health.speaking },
    { label: 'LiveKit', ...health.livekit },
    {
      label: '麥克風',
      ok: micActive && !micError,
      note: micError ?? (micActive ? '麥克風運作中' : '麥克風尚未啟用'),
    },
  ];
  const stale = lastUpdate > 0 && Date.now() - lastUpdate > 30_000;

  return (
    <div
      className="absolute top-[max(0.75rem,env(safe-area-inset-top))] left-1/2 -translate-x-1/2 z-30 flex items-center gap-2.5 px-3 py-1.5 rounded-full bg-black/35 backdrop-blur-sm"
      aria-label="饅頭語音服務健康狀態"
    >
      {lights.map((light) => (
        <div key={light.label} className="flex items-center gap-1" title={light.note}>
          <span
            className={`inline-block w-2 h-2 rounded-full ${
              light.ok
                ? 'bg-green-400 shadow-[0_0_4px_rgba(74,222,128,0.65)]'
                : 'bg-red-400 shadow-[0_0_4px_rgba(248,113,113,0.65)]'
            } ${stale && !light.ok ? 'animate-pulse' : ''}`}
          />
          <span className="text-[10px] text-white/75 font-light tracking-wide whitespace-nowrap">
            {light.label}
          </span>
        </div>
      ))}
    </div>
  );
}
