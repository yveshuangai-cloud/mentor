import { useEffect, useState } from 'react';
import type { CallStatus, FelicityState } from '../hooks/useWebSocket';
import BreathingOrb from './BreathingOrb';
import HealthIndicator from './HealthIndicator';

interface Props {
  callStatus: CallStatus;
  felicityState: FelicityState;
  micActive: boolean;
  micError: string | null;
  isMuted: boolean;
  isSpeakerOn: boolean;
  onHangUp: () => void;
  onRetry: () => void;
  onToggleMute: () => void;
  onToggleSpeaker: () => void;
  getMicVolume: () => number;
  getRemoteVolume: () => number;
}

function useTimer(active: boolean): string {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

const stateLabel: Record<FelicityState, string> = {
  listening: '正在聽你說',
  hearing: '聽見了',
  thinking: '正在想',
  speaking: '饅頭正在說話',
  interrupting: '停下來聽你說',
};

export default function CallScreen(props: Props) {
  const active = props.callStatus === 'active';
  const ringing = props.callStatus === 'ringing' || props.callStatus === 'connecting';
  const ended = props.callStatus === 'ended';
  const failed = props.callStatus === 'error';
  const timer = useTimer(active);

  return (
    <main className="fixed inset-0 bg-gradient-to-b from-[#1f2937] to-[#0b1220] text-white flex flex-col items-center">
      <BreathingOrb
        getMicVolume={props.getMicVolume}
        getRemoteVolume={props.getRemoteVolume}
        active={active || ringing}
      />
      <HealthIndicator micActive={props.micActive} micError={props.micError} />
      <section className="relative z-10 flex-1 flex flex-col items-center justify-center px-8">
        <img
          src="/avatar.jpg"
          alt="饅頭"
          className={`w-40 h-40 rounded-full object-cover object-top shadow-2xl ring-4 ring-white/10 ${ringing || props.felicityState === 'speaking' ? 'animate-pulse' : ''}`}
        />
        <h1 className="mt-7 text-2xl tracking-widest">饅頭</h1>
        <p className="mt-2 text-white/55 text-sm">{active ? timer : ringing ? '正在接通…' : ended ? '通話已結束' : failed ? '連線失敗' : ''}</p>

        {active && (
          <div className="mt-6 min-h-10 flex items-center gap-2 rounded-full bg-white/10 px-5 py-2 text-sm text-white/75">
            {props.felicityState === 'thinking' && (
              <span className="flex gap-1" aria-label="正在思考">
                {[0, 1, 2].map((index) => <i key={index} className="w-1.5 h-1.5 rounded-full bg-amber-300 animate-bounce" style={{ animationDelay: `${index * 150}ms` }} />)}
              </span>
            )}
            <span>{stateLabel[props.felicityState]}</span>
          </div>
        )}

        {props.micError && <p className="mt-4 max-w-xs text-center text-sm text-red-300">{props.micError}</p>}
        {active && <p className="mt-3 text-xs text-white/35">{props.isMuted ? '麥克風已關閉' : props.micActive ? '麥克風已開啟' : '正在取得麥克風權限'}</p>}
      </section>

      {(active || ringing) && (
        <footer className="relative z-10 w-full max-w-md flex items-center justify-around px-8 pb-12">
          <Control label={props.isMuted ? '開啟麥克風' : '靜音'} active={props.isMuted} onClick={props.onToggleMute}>🎙</Control>
          <button onClick={props.onHangUp} aria-label="掛斷" className="w-16 h-16 rounded-full bg-red-500 text-2xl shadow-lg active:scale-90 transition-transform">×</button>
          <Control label={props.isSpeakerOn ? '關閉擴音' : '開啟擴音'} active={props.isSpeakerOn} onClick={props.onToggleSpeaker}>🔊</Control>
        </footer>
      )}

      {(ended || failed) && (
        <footer className="relative z-10 pb-12 flex gap-3">
          {failed && <button onClick={props.onRetry} className="px-6 py-3 rounded-full bg-[#06C755]">重新連線</button>}
          <button onClick={props.onHangUp} className="px-6 py-3 rounded-full bg-white/10">關閉</button>
        </footer>
      )}
    </main>
  );
}

function Control({ label, active, onClick, children }: { label: string; active: boolean; onClick: () => void; children: string }) {
  return (
    <button onClick={onClick} className="flex flex-col items-center gap-2 text-xs text-white/70">
      <span className={`w-14 h-14 rounded-full flex items-center justify-center text-xl ${active ? 'bg-white text-slate-900' : 'bg-white/15'}`}>{children}</span>
      {label}
    </button>
  );
}
