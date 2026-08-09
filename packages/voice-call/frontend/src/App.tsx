import { useCallback, useEffect, useState } from 'react';
import { closeLiff, createVoiceSession, getLiffProfile, initLiff, type LiffProfile } from './lib/liff';
import { useAudio } from './hooks/useAudio';
import { useWebSocket } from './hooks/useWebSocket';
import CallScreen from './components/CallScreen';
import DialTone from './components/DialTone';
import MicPermission from './components/MicPermission';

export default function App() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [micConsent, setMicConsent] = useState(false);
  const [starting, setStarting] = useState(false);

  const audio = useAudio({
    onAudioChunk: (chunk) => ws.sendAudioChunk(chunk),
    onSpeechStart: () => {
      if (ws.felicityStateRef.current === 'speaking') {
        ws.sendInterrupt();
        audio.fadeOutPlayback();
        ws.updateFelicityState('interrupting');
      }
    },
  });

  const ws = useWebSocket({
    onReady: () => {
      audio.warmUpPlayback();
      audio.preloadFillers();
    },
    onAudioStream: (data) => {
      audio.stopFiller();
      audio.playAudioChunk(data);
    },
    onAudioDone: () => audio.flushBuffer(true),
    onAudioClear: () => audio.stopPlayback(),
    onAudioFadeout: () => audio.fadeOutPlayback(),
    onFiller: (index) => audio.playFiller(index),
    onError: (message) => console.error('[mantou-voice]', message),
    onEnded: () => {
      audio.stopMic();
      audio.stopPlayback();
    },
  });

  const connect = useCallback(async () => {
    const session = await createVoiceSession();
    ws.connect(session.token, session.sessionId);
  }, [ws]);

  useEffect(() => {
    void (async () => {
      try {
        await initLiff();
        setProfile(await getLiffProfile());
      } catch (error) {
        setInitError(error instanceof Error ? error.message : '無法啟動 LINE 通話。');
      }
    })();
  }, []);

  const beginCall = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    setInitError(null);
    try {
      // Must happen inside the user's click gesture. LINE WebView may otherwise
      // leave AudioContext suspended even though getUserMedia was granted.
      await audio.startMic();
      setMicConsent(true);
      await connect();
    } catch (error) {
      audio.stopMic();
      setMicConsent(false);
      setInitError(error instanceof Error ? error.message : '無法啟動麥克風。');
    } finally {
      setStarting(false);
    }
  }, [audio, connect, starting]);

  const hangUp = useCallback(() => {
    ws.hangUp();
    audio.stopMic();
    audio.stopPlayback();
    setTimeout(closeLiff, 700);
  }, [audio, ws]);

  const retry = useCallback(() => {
    setInitError(null);
    void beginCall();
  }, [beginCall]);

  if (initError) {
    return (
      <div className="fixed inset-0 bg-[#111827] flex flex-col items-center justify-center px-8 text-center">
        <img src="/avatar.jpg" alt="饅頭" className="w-24 h-24 rounded-full object-cover object-top shadow-xl" />
        <h1 className="mt-6 text-white text-xl">饅頭暫時接不到電話</h1>
        <p className="mt-2 text-white/60 text-sm leading-6">{initError}</p>
        <button onClick={() => window.location.reload()} className="mt-7 px-7 py-3 rounded-full bg-[#06C755] text-white">重新連線</button>
      </div>
    );
  }

  if (profile && !micConsent) {
    return <MicPermission onAllow={() => void beginCall()} onDeny={closeLiff} />;
  }

  if (!profile || ws.callStatus === 'idle') {
    return (
      <div className="fixed inset-0 bg-[#111827] flex flex-col items-center justify-center">
        <img src="/avatar.jpg" alt="饅頭" className="w-24 h-24 rounded-full object-cover object-top shadow-xl animate-pulse" />
        <p className="mt-5 text-white/60">正在接通饅頭…</p>
      </div>
    );
  }

  return (
    <>
      <DialTone playing={ws.callStatus === 'ringing' || ws.callStatus === 'connecting'} maxBeeps={5} />
      <CallScreen
        callStatus={ws.callStatus}
        felicityState={ws.felicityState}
        micActive={audio.micActive}
        micError={audio.micError}
        isMuted={audio.isMuted}
        isSpeakerOn={audio.isSpeakerOn}
        onHangUp={hangUp}
        onRetry={retry}
        onToggleMute={audio.toggleMute}
        onToggleSpeaker={audio.toggleSpeaker}
      />
    </>
  );
}
