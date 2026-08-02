/**
 * 包容語音通話 LIFF App — 主入口
 *
 * 流程：
 * 1. 初始化 LIFF → 取得 userId
 * 2. 建立 WebSocket → 撥號 → 嘟嘟嘟
 * 3. 收到 call:ready → 啟動麥克風（瀏覽器首次會彈權限，之後記住）→ 進入通話
 * 4. 掛斷 → 關閉 LIFF
 *
 * 麥克風權限只在 onReady 時請求一次，避免重複彈窗
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { initLiff, getLiffProfile, closeLiff, getSessionId, type LiffProfile } from './lib/liff';
import { useWebSocket } from './hooks/useWebSocket';
import { useAudio } from './hooks/useAudio';
import CallScreen from './components/CallScreen';
import DialTone from './components/DialTone';
import LocationConsentCard from './components/LocationConsentCard';

export default function App() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  // 📍 地理定位同意卡（慢慢想知道你在哪時，後端 location:request 觸發浮出）
  const [locCard, setLocCard] = useState<{ open: boolean; reason?: string | null }>({ open: false });
  // 2026-06-18 拿掉自家綠色 MicPermission dialog（潛意識反饋兩層權限太煩）
  // 改成只靠 browser native 對話框 — 用戶點「允許本次」時 native dialog 那個 click 就是 user gesture
  // → AudioContext.resume() 在 startMic 成功之後跑即可
  const startedRef = useRef(false);

  // ===== Audio Hook =====
  const audio = useAudio({
    onAudioChunk: (chunk) => {
      ws.sendAudioChunk(chunk);
    },
    onSpeechStart: () => {
      // 用戶開口 → 只在 AI 正在說話時才打斷
      // 注意：必須用 ref 讀取最新值，避免 stale closure 導致永遠讀到舊值
      if (ws.felicityStateRef.current === 'speaking') {
        ws.sendInterrupt();
        // 🎵 軟著陸：fade-out 取代立刻斷音（後端也會送 audio:fadeout）
        audio.fadeOutPlayback();
        // 前端立即切換為「插話中」狀態，後端稍後會送 listening 覆蓋
        ws.updateFelicityState('interrupting');
      }
    },
  });

  // ===== WebSocket Hook =====
  const ws = useWebSocket({
    onReady: async (_greeting) => {
      // 通話就緒 → 先 trigger 麥克風 native dialog（在這裡用戶會看到「是否允許麥克風」）
      // 用戶點允許 = user gesture → 之後 warmUpPlayback 的 AudioContext 才能 resume
      await audio.startMic();
      audio.warmUpPlayback();  // gesture chain 內 → AudioContext 可 resume
      audio.preloadFillers();

      // iOS 13+ DeviceOrientation 權限（同樣需要 gesture，剛才 native 允許就有了）
      try {
        const DOE = (window as any).DeviceOrientationEvent;
        if (DOE && typeof DOE.requestPermission === 'function') {
          await DOE.requestPermission().catch(() => undefined);
        }
      } catch { /* 非 iOS / 不支援 — 無視 */ }
    },
    onAudioStream: (data) => {
      // 收到真正的 TTS 音訊 → 停止 filler，播放真正回覆
      audio.stopFiller();
      audio.playAudioChunk(data);
    },
    onAudioDone: () => {
      // AI 說完了 → 強制 flush 所有殘餘 MP3 緩衝（包含不完整 frame）
      audio.flushBuffer(true);
    },
    onAudioClear: () => {
      // 🔧 強制清空：投機 TTS 被取消 / 新回覆開始前清空殘留音訊
      // 與 audio:done（flush 繼續播）不同，這裡是立刻停止 + 丟棄 buffer
      audio.stopPlayback();
    },
    onAudioFadeout: () => {
      // 🎵 軟著陸：後端打斷，fade-out 300ms 再停（不是立刻斷）
      audio.fadeOutPlayback();
    },
    onFiller: (index) => {
      // 後端偵測到用戶說完 → 立刻播放「嗯...」filler
      audio.playFiller(index);
    },
    onToolUse: (_tool, phase) => {
      // 🔎 慢慢啟動 tool（search_memory / verify_my_memory / web_search / read_destiny 等）
      // 播個小音效讓潛意識感覺到她在搜尋
      audio.playSearchBlip(phase);
    },
    onLocationRequest: (reason) => {
      // 📍 慢慢想知道你在哪 → 浮出同意卡（只有用戶點允許才會真的定位）
      setLocCard({ open: true, reason });
    },
    onError: (msg) => {
      console.error('通話錯誤:', msg);
    },
    onEnded: () => {
      audio.stopMic();
      audio.stopPlayback();
    },
  });

  // ===== 初始化 =====
  useEffect(() => {
    async function init() {
      try {
        await initLiff();
        const p = await getLiffProfile();
        setProfile(p);
      } catch (err) {
        setInitError(err instanceof Error ? err.message : 'LIFF 初始化失敗');
      }
    }
    init();
  }, []);

  // ===== Profile 取得後 → 自動開始撥號（麥克風在 onReady 時才 native dialog 跳出）=====
  useEffect(() => {
    if (profile && !startedRef.current) {
      startedRef.current = true;
      const sessionId = getSessionId();
      ws.connect(profile.userId, sessionId);
    }
  }, [profile, ws]);

  // ===== 掛斷 =====
  const handleHangUp = useCallback(() => {
    ws.hangUp();
    audio.stopMic();
    audio.stopPlayback();
    // 延遲關閉 LIFF，讓道別動畫播完
    setTimeout(() => {
      closeLiff();
    }, 1500);
  }, [ws, audio]);

  // ===== 重試 =====
  const handleRetry = useCallback(() => {
    if (profile) {
      startedRef.current = false;
      const sessionId = getSessionId();
      ws.connect(profile.userId, sessionId);
    }
  }, [profile, ws]);

  // ===== 嘟嘟嘟超時 =====
  const handleDialTimeout = useCallback(() => {
    console.warn('撥號超時');
  }, []);

  // ===== 靜音切換 =====
  const handleToggleMute = useCallback(() => {
    audio.toggleMute();
  }, [audio]);

  // ===== 擴音切換 =====
  const handleToggleSpeaker = useCallback(() => {
    audio.toggleSpeaker();
  }, [audio]);

  // 初始化錯誤 / 麥克風拒絕
  if (initError) {
    return (
      <div className="fixed inset-0 bg-line-dark flex flex-col items-center justify-center px-6">
        <div className="w-24 h-24 rounded-full overflow-hidden mb-6 opacity-50">
          <img src="/avatar.png" alt="avatar" className="w-full h-full object-cover" />
        </div>
        <p className="text-white/60 text-sm text-center mb-1">無法連線</p>
        <p className="text-white/30 text-xs text-center">{initError}</p>
        <button
          onClick={() => window.location.reload()}
          className="mt-6 px-6 py-3 rounded-full bg-line-green text-white text-sm font-medium"
        >
          重試
        </button>
      </div>
    );
  }

  // 載入中（LIFF 初始化 / WS 尚未開始）
  if (!profile || ws.callStatus === 'idle') {
    return (
      <div className="fixed inset-0 bg-line-dark flex flex-col items-center justify-center">
        <div className="w-20 h-20 rounded-full overflow-hidden animate-pulse-slow">
          <img src="/avatar.png" alt="avatar" className="w-full h-full object-cover" />
        </div>
        <p className="mt-4 text-white/40 text-sm">連線中...</p>
      </div>
    );
  }

  return (
    <>
      {/* 嘟嘟嘟等待音 */}
      <DialTone
        playing={ws.callStatus === 'ringing' || ws.callStatus === 'connecting'}
        maxBeeps={5}
        onTimeout={handleDialTimeout}
      />

      {/* 通話畫面（LINE 風格） */}
      <CallScreen
        callStatus={ws.callStatus}
        felicityState={ws.felicityState}
        micActive={audio.micActive}
        micError={audio.micError}
        isMuted={audio.isMuted}
        isSpeakerOn={audio.isSpeakerOn}
        onHangUp={handleHangUp}
        onRetry={handleRetry}
        onToggleMute={handleToggleMute}
        onToggleSpeaker={handleToggleSpeaker}
        getMicVolume={audio.getMicVolume}
        getRemoteVolume={audio.getRemoteVolume}
        userId={profile?.userId}
      />

      {/* 📍 地理定位同意卡（慢慢想知道你在哪時浮出） */}
      <LocationConsentCard
        open={locCard.open}
        userId={profile?.userId}
        reason={locCard.reason}
        onClose={() => setLocCard({ open: false })}
      />
    </>
  );
}
