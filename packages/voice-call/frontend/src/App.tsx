import { useCallback, useEffect, useRef, useState } from 'react';
import { closeLiff, createVoiceSession, getLiffProfile, initLiff, type LiffProfile } from './lib/liff';
import { useAudio } from './hooks/useAudio';
import { useWebSocket } from './hooks/useWebSocket';
import { useLiveKit } from './hooks/useLiveKit';
import CallScreen from './components/CallScreen';
import DialTone from './components/DialTone';

export default function App() {
  const [profile, setProfile] = useState<LiffProfile | null>(null);
  const [initError, setInitError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const [transport, setTransport] = useState<'websocket' | 'livekit'>('websocket');
  const startedRef = useRef(false);
  const livekit = useLiveKit();

  const audio = useAudio({
    onAudioChunk: (chunk) => ws.sendAudioChunk(chunk),
    onPlaybackStart: (generation) => ws.sendPlaybackStarted(generation),
    onSpeechStart: () => {
      if (ws.felicityStateRef.current === 'speaking') {
        console.info('[mantou-voice] local barge-in detected');
        ws.sendInterrupt();
        // Stop locally at once so the caller's next PCM chunk can reach STT.
        // The server still cancels the LLM/TTS generation independently.
        audio.stopPlayback(0);
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
    onAudioSegment: (generation) => audio.beginAudioSegment(generation),
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
      // LiveKit owns microphone capture when selected. The legacy transport
      // keeps its existing Web Audio capture as a safe rollback path.
      const session = await createVoiceSession();
      setTransport(session.transport);
      if (session.transport === 'livekit') await livekit.connect(session);
      else {
        await audio.startMic();
        ws.connect(session.token, session.sessionId);
      }
    } catch (error) {
      audio.stopMic();
      startedRef.current = false;
      setInitError(error instanceof Error ? error.message : '無法啟動麥克風。');
    } finally {
      setStarting(false);
    }
  }, [audio, livekit, starting, ws]);

  useEffect(() => {
    if (!profile || initError || startedRef.current) return;
    startedRef.current = true;
    void beginCall();
  }, [beginCall, initError, profile]);

  const hangUp = useCallback(() => {
    if (transport === 'livekit') livekit.hangUp();
    else {
      ws.hangUp();
      audio.stopMic();
      audio.stopPlayback();
    }
    setTimeout(closeLiff, 700);
  }, [audio, livekit, transport, ws]);

  const retry = useCallback(() => {
    startedRef.current = true;
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

  const call = transport === 'livekit'
    ? livekit
    : {
        callStatus: ws.callStatus,
        felicityState: ws.felicityState,
        micActive: audio.micActive,
        micError: audio.micError,
        isMuted: audio.isMuted,
        isSpeakerOn: audio.isSpeakerOn,
        toggleMute: audio.toggleMute,
        toggleSpeaker: audio.toggleSpeaker,
        getMicVolume: audio.getMicVolume,
        getRemoteVolume: audio.getRemoteVolume,
      };

  if (!profile || call.callStatus === 'idle') {
    return (
      <div className="fixed inset-0 bg-[#111827] flex flex-col items-center justify-center">
        <img src="/avatar.jpg" alt="饅頭" className="w-24 h-24 rounded-full object-cover object-top shadow-xl animate-pulse" />
        <p className="mt-5 text-white/60">正在接通饅頭…</p>
      </div>
    );
  }

  return (
    <>
      <DialTone playing={call.callStatus === 'ringing' || call.callStatus === 'connecting'} maxBeeps={5} />
      <CallScreen
        callStatus={call.callStatus}
        felicityState={call.felicityState}
        micActive={call.micActive}
        micError={call.micError}
        playbackError={transport === 'livekit' ? livekit.playbackError : null}
        mediaActivationRequired={transport === 'livekit' ? livekit.mediaActivationRequired : false}
        isMuted={call.isMuted}
        isSpeakerOn={call.isSpeakerOn}
        onHangUp={hangUp}
        onRetry={retry}
        onActivateMedia={transport === 'livekit' ? livekit.activateMedia : () => undefined}
        onToggleMute={call.toggleMute}
        onToggleSpeaker={call.toggleSpeaker}
        getMicVolume={call.getMicVolume}
        getRemoteVolume={call.getRemoteVolume}
      />
    </>
  );
}
