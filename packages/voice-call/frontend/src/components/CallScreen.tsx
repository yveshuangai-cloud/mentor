/**
 * 通話主畫面 — 完全仿照 LINE 語音通話介面
 *
 * 設計參考 LINE 通話 UI：
 * - 全螢幕模糊頭像背景
 * - 大圓形頭像居中偏上
 * - 名字 + 狀態文字在頭像下方
 * - 底部三按鈕：關閉麥克風 / 掛斷(X) / 開啟擴音
 * - 右上角 LINE 圖示
 */

import { useState, useEffect, useRef } from 'react';
import { type FelicityState, type CallStatus } from '../hooks/useWebSocket';
import BreathingOrb from './BreathingOrb';
import RainWindow from './RainWindow';
import HealthIndicator from './HealthIndicator';
import MonologuePanel from './MonologuePanel';

// 🌧️ 台北當天是否下雨（Open-Meteo，免金鑰）— 下雨時通話桌面換成雨窗特效
// WMO weather_code 毛毛雨/雨/陣雨/雷雨 = 下雨；或當前 precipitation > 0。?rain=1 可強制測試。
function useTaipeiRain(): boolean {
  const [raining, setRaining] = useState(false);
  useEffect(() => {
    try {
      if (new URLSearchParams(window.location.search).has('rain')) { setRaining(true); return; }
    } catch { /* ignore */ }
    const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
    fetch('https://api.open-meteo.com/v1/forecast?latitude=25.038&longitude=121.565&current=precipitation,weather_code&timezone=Asia%2FTaipei')
      .then((r) => r.json())
      .then((d) => {
        const cur = d?.current;
        setRaining((cur?.precipitation ?? 0) > 0 || RAIN_CODES.has(cur?.weather_code));
      })
      .catch(() => setRaining(false));
  }, []);
  return raining;
}

interface CallScreenProps {
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
  /** 借語靈設計 — 中央呼吸光球聲浪 getter（通話中才畫） */
  getMicVolume?: () => number;
  getRemoteVolume?: () => number;
  /** LINE userId — 內心獨白面板的隱私閘 viewer */
  userId?: string;
}

// 通話計時 hook
function useCallTimer(isActive: boolean) {
  const [seconds, setSeconds] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isActive) {
      setSeconds(0);
      timerRef.current = setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);
    } else {
      if (timerRef.current) clearInterval(timerRef.current);
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [isActive]);

  const mm = String(Math.floor(seconds / 60)).padStart(2, '0');
  const ss = String(seconds % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

export default function CallScreen({
  callStatus,
  felicityState,
  micActive,
  micError,
  isMuted,
  isSpeakerOn,
  onHangUp,
  onRetry,
  onToggleMute,
  onToggleSpeaker,
  getMicVolume,
  getRemoteVolume,
  userId,
}: CallScreenProps) {
  const isActive = callStatus === 'active';
  const isRinging = callStatus === 'ringing' || callStatus === 'connecting';
  const isEnded = callStatus === 'ended';
  const isError = callStatus === 'error';
  const callTime = useCallTimer(isActive);
  const [showMonologue, setShowMonologue] = useState(false);
  const isRaining = useTaipeiRain();  // 🌧️ 台北下雨 → 通話桌面換雨窗特效
  const [manualRain, setManualRain] = useState(false);  // 右上角雨滴鈕：手動立刻開特效
  const rainOn = isRaining || manualRain;

  // 狀態副標（LINE 在名字下面顯示的小字）
  function getSubtitle(): string {
    if (isRinging) return '撥號中...';
    if (isActive) return callTime;
    if (isEnded) return '通話結束';
    if (isError) return '連線失敗';
    return '準備中...';
  }

  return (
    <div className="fixed inset-0 flex flex-col">
      {/* ====== 全螢幕模糊背景（LINE 風格） ====== */}
      <div className="absolute inset-0">
        {/* 頭像背景圖（拉伸 + 模糊） */}
        <img
          src="/avatar.png"
          alt=""
          className="absolute inset-0 w-full h-full object-cover scale-110"
        />
        {/* 模糊暗化遮罩 */}
        <div className="absolute inset-0 bg-blur-overlay" />
        {/* 額外暗化層（確保文字可讀） */}
        <div className="absolute inset-0 bg-black/30" />
      </div>

      {/* ====== 🌧️ 雨窗特效（台北下雨時 或 手動開）— 隔著一片下雨的窗看慢慢 ====== */}
      {rainOn && (
        <RainWindow getMicVolume={getMicVolume} getRemoteVolume={getRemoteVolume} />
      )}

      {/* ====== 左上角 漢堡選單 → 慢慢的內心獨白 ====== */}
      <button
        onClick={() => setShowMonologue(true)}
        aria-label="慢慢的內心獨白"
        className="absolute top-12 left-4 z-30 w-10 h-10 rounded-full bg-white/10 flex flex-col items-center justify-center gap-[3px] active:scale-90 transition-transform"
      >
        <span className="block w-4 h-[2px] bg-white/70 rounded-full" />
        <span className="block w-4 h-[2px] bg-white/70 rounded-full" />
        <span className="block w-4 h-[2px] bg-white/70 rounded-full" />
      </button>
      <MonologuePanel open={showMonologue} onClose={() => setShowMonologue(false)} viewerId={userId} />

      {/* ====== 中央呼吸光球（借語靈設計 2026-06-18） ====== */}
      {/* 慢慢講話 = 青綠 (hue 158) / 用戶講話 = 冷白藍 (hue 192) */}
      {/* 通話中或撥號中才啟用，避免閒置時也跑動畫 */}
      {getMicVolume && getRemoteVolume && (
        <BreathingOrb
          getMicVolume={getMicVolume}
          getRemoteVolume={getRemoteVolume}
          active={isActive || isRinging}
        />
      )}

      {/* ====== 頂部正中央 — 5 個服務健康燈 ====== */}
      <HealthIndicator micActive={micActive} micError={micError} />

      {/* ====== 右上角：雨滴特效鈕 + LINE 圖示 ====== */}
      <div className="relative z-20 flex justify-end items-center gap-2 pt-12 pr-4 pointer-events-none">
        {/* 🌧️ 雨滴鈕：點一下立刻開/關雨窗特效（不用等下雨） */}
        <button
          onClick={() => setManualRain(v => !v)}
          aria-label={rainOn ? '關閉雨窗特效' : '開啟雨窗特效'}
          className={`pointer-events-auto w-10 h-10 rounded-full flex items-center justify-center active:scale-90 transition-all ${rainOn ? 'bg-sky-400/30' : 'bg-white/10'}`}
        >
          <svg width="20" height="22" viewBox="0 0 24 24" fill={rainOn ? '#8fd3f0' : 'none'} stroke="white" strokeOpacity="0.7" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2.7c0 0 6.5 7.4 6.5 11.9a6.5 6.5 0 0 1-13 0C5.5 10.1 12 2.7 12 2.7z" />
          </svg>
        </button>
        <div className="w-10 h-10 rounded-full bg-white/10 flex items-center justify-center">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="white" opacity="0.6">
            <path d="M19.365 9.863c.349 0 .63.285.63.631 0 .345-.281.63-.63.63H17.61v1.125h1.755c.349 0 .63.283.63.63 0 .344-.281.629-.63.629h-2.386c-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63h2.386c.346 0 .627.285.627.63 0 .349-.281.63-.63.63H17.61v1.125h1.755zm-3.855 3.016c0 .27-.174.51-.432.596-.064.021-.133.031-.199.031-.211 0-.391-.09-.51-.25l-2.443-3.317v2.94c0 .344-.279.629-.631.629-.346 0-.626-.285-.626-.629V8.108c0-.27.173-.51.43-.595.06-.023.136-.033.194-.033.195 0 .375.104.495.254l2.462 3.33V8.108c0-.345.282-.63.63-.63.345 0 .63.285.63.63v4.771zm-5.741 0c0 .344-.282.629-.631.629-.345 0-.627-.285-.627-.629V8.108c0-.345.282-.63.63-.63.346 0 .628.285.628.63v4.771zm-2.466.629H4.917c-.345 0-.63-.285-.63-.629V8.108c0-.345.285-.63.63-.63.348 0 .63.285.63.63v4.141h1.756c.348 0 .629.283.629.63 0 .344-.282.629-.629.629M24 10.314C24 4.943 18.615.572 12 .572S0 4.943 0 10.314c0 4.811 4.27 8.842 10.035 9.608.391.082.923.258 1.058.59.12.301.079.766.038 1.08l-.164 1.02c-.045.301-.24 1.186 1.049.645 1.291-.539 6.916-4.078 9.436-6.975C23.176 14.393 24 12.458 24 10.314" />
          </svg>
        </div>
      </div>

      {/* ====== 主內容區：頭像 + 名字 + 狀態 ====== */}
      <div className="relative z-10 flex-1 flex flex-col items-center justify-start pt-8">
        {/* 大圓形頭像（LINE 風格：灰色半透明外圈） */}
        <div className="relative">
          {/* 外圈呼吸動畫（撥號中） */}
          {isRinging && (
            <>
              <div className="absolute -inset-3 rounded-full bg-white/10 animate-ripple" />
              <div className="absolute -inset-3 rounded-full bg-white/5 animate-ripple" style={{ animationDelay: '0.8s' }} />
            </>
          )}
          {/* 通話中外圈光（AI 說話時亮綠光，插話時亮橘光） */}
          {isActive && felicityState === 'speaking' && (
            <div className="absolute -inset-2 rounded-full bg-line-green/20 animate-pulse-slow" />
          )}
          {isActive && felicityState === 'interrupting' && (
            <div className="absolute -inset-2 rounded-full bg-orange-400/20 animate-pulse-slow" />
          )}

          {/* 頭像本體 */}
          <div className="relative w-40 h-40 rounded-full overflow-hidden avatar-ring">
            <img
              src="/avatar.png"
              alt="avatar"
              className="w-full h-full object-cover"
            />
            {/* 半透明外環（LINE 風格） */}
            <div className="absolute inset-0 rounded-full border-[3px] border-white/15" />
          </div>
        </div>

        {/* 名字 */}
        <h1 className="mt-6 text-[22px] font-normal tracking-wide text-white">
          {/* SOUL-SLOT: 換成你的人格顯示名 */}
          {'慢慢'}
        </h1>

        {/* 狀態指示（LINE 風格：綠色跳動圓點 / 通話時間） */}
        <div className="mt-2 h-6 flex items-center justify-center">
          {isRinging ? (
            /* 三個綠色跳動圓點（LINE 撥號中樣式） */
            <div className="flex gap-1.5">
              <div
                className="w-2 h-2 rounded-full bg-line-green animate-dot-bounce"
                style={{ animationDelay: '0ms' }}
              />
              <div
                className="w-2 h-2 rounded-full bg-line-green animate-dot-bounce"
                style={{ animationDelay: '200ms' }}
              />
              <div
                className="w-2 h-2 rounded-full bg-line-green animate-dot-bounce"
                style={{ animationDelay: '400ms' }}
              />
            </div>
          ) : (
            <p className="text-sm text-white/60 tracking-wide">
              {getSubtitle()}
            </p>
          )}
        </div>

        {/* AI 狀態提示（通話中額外顯示） */}
        {isActive && (
          <div className="mt-3 animate-fade-in">
            <span className={`
              text-xs tracking-wider px-3 py-1 rounded-full transition-colors duration-300
              ${felicityState === 'speaking'
                ? 'text-line-green/90 bg-line-green/10'
                : felicityState === 'interrupting'
                  ? 'text-orange-400/90 bg-orange-400/10'
                  : felicityState === 'thinking'
                    ? 'text-yellow-400/80 bg-yellow-400/10'
                    : 'text-white/40 bg-white/5'
              }
            `}>
              {felicityState === 'listening' && '靜默等待中...'}
              {felicityState === 'hearing' && '對方說話中...'}
              {felicityState === 'thinking' && '思考中...'}
              {felicityState === 'speaking' && '說話中'}
              {felicityState === 'interrupting' && '插話中'}
            </span>
          </div>
        )}

        {/* 麥克風錯誤 */}
        {micError && (
          <p className="mt-3 text-xs text-red-400/80 text-center max-w-[250px] animate-fade-in">
            {micError}
          </p>
        )}

        {/* 麥克風狀態小點 */}
        {isActive && (
          <div className="mt-2 flex items-center gap-1.5 text-xs text-white/30">
            <div className={`w-1.5 h-1.5 rounded-full ${micActive && !isMuted ? 'bg-line-green animate-pulse' : 'bg-white/20'}`} />
            {isMuted ? '已靜音' : micActive ? '麥克風已開啟' : '麥克風未啟動'}
          </div>
        )}
      </div>

      {/* ====== 底部控制列（LINE 風格三按鈕） ====== */}
      <div className="relative z-10 safe-bottom">
        {(isActive || isRinging) && (
          <div className="flex items-end justify-around px-8 pb-8 pt-6">
            {/* 左：關閉/開啟麥克風 */}
            <button
              onClick={onToggleMute}
              className="flex flex-col items-center gap-2 active:scale-95 transition-transform"
              aria-label={isMuted ? '開啟麥克風' : '關閉麥克風'}
            >
              <div className={`
                w-14 h-14 rounded-full flex items-center justify-center
                transition-colors duration-200
                ${isMuted ? 'bg-white/90' : 'bg-white/15'}
              `}>
                {isMuted ? (
                  /* 靜音：斜線麥克風（深色 icon） */
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="1" y1="1" x2="23" y2="23" />
                    <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                    <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2c0 .91-.18 1.78-.5 2.58" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                ) : (
                  /* 正常：白色麥克風 */
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="9" y="1" width="6" height="11" rx="3" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                )}
              </div>
              <span className={`text-[11px] ${isMuted ? 'text-white/90' : 'text-white/60'}`}>
                {isMuted ? '開啟麥克風' : '關閉麥克風'}
              </span>
            </button>

            {/* 中：掛斷（紅色圓 + 白X，LINE 風格） */}
            <button
              onClick={onHangUp}
              className="flex flex-col items-center gap-2 active:scale-90 transition-transform"
              aria-label="掛斷"
            >
              <div className="w-16 h-16 rounded-full bg-call-red flex items-center justify-center shadow-lg shadow-call-red/30">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </div>
            </button>

            {/* 右：擴音 */}
            <button
              onClick={onToggleSpeaker}
              className="flex flex-col items-center gap-2 active:scale-95 transition-transform"
              aria-label={isSpeakerOn ? '關閉擴音' : '開啟擴音'}
            >
              <div className={`
                w-14 h-14 rounded-full flex items-center justify-center
                transition-colors duration-200
                ${isSpeakerOn ? 'bg-white/90' : 'bg-white/15'}
              `}>
                {isSpeakerOn ? (
                  /* 擴音開啟：深色 icon + 聲波 */
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#333" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                ) : (
                  /* 擴音關閉：白色 icon + 單聲波 */
                  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                  </svg>
                )}
              </div>
              <span className={`text-[11px] ${isSpeakerOn ? 'text-white/90' : 'text-white/60'}`}>
                {isSpeakerOn ? '關閉擴音' : '開啟擴音'}
              </span>
            </button>
          </div>
        )}

        {/* 結束 / 錯誤狀態 */}
        {(isEnded || isError) && (
          <div className="flex flex-col items-center gap-4 pb-12">
            {isError && (
              <button
                onClick={onRetry}
                className="px-8 py-3 rounded-full bg-line-green text-white text-sm font-medium active:scale-95 transition-all"
              >
                重新撥號
              </button>
            )}
            <button
              onClick={onHangUp}
              className="px-8 py-3 rounded-full bg-white/10 text-white/70 text-sm active:scale-95 transition-all"
            >
              關閉
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
