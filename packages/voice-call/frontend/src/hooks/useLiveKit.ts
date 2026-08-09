import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Room,
  RoomEvent,
  Track,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
} from 'livekit-client';
import type { LiveKitVoiceSession } from '../lib/liff';
import type { CallStatus, FelicityState } from './useWebSocket';

const agentStates = new Set<FelicityState>(['listening', 'thinking', 'speaking']);

export function useLiveKit() {
  const roomRef = useRef<Room | null>(null);
  const remoteParticipantRef = useRef<RemoteParticipant | null>(null);
  const audioElementsRef = useRef<HTMLMediaElement[]>([]);
  const analysisContextRef = useRef<AudioContext | null>(null);
  const analysisSinkRef = useRef<GainNode | null>(null);
  const micSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const remoteSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const micAnalyserRef = useRef<AnalyserNode | null>(null);
  const remoteAnalyserRef = useRef<AnalyserNode | null>(null);
  const micVolumeBufferRef = useRef<Uint8Array | null>(null);
  const remoteVolumeBufferRef = useRef<Uint8Array | null>(null);
  const [callStatus, setCallStatus] = useState<CallStatus>('idle');
  const [felicityState, setFelicityState] = useState<FelicityState>('listening');
  const [micActive, setMicActive] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isSpeakerOn, setIsSpeakerOn] = useState(true);

  const cleanupAudio = useCallback(() => {
    for (const element of audioElementsRef.current) element.remove();
    audioElementsRef.current = [];
  }, []);

  const cleanupAnalysis = useCallback(() => {
    micSourceRef.current?.disconnect();
    remoteSourceRef.current?.disconnect();
    micAnalyserRef.current?.disconnect();
    remoteAnalyserRef.current?.disconnect();
    analysisSinkRef.current?.disconnect();
    if (analysisContextRef.current?.state !== 'closed') {
      void analysisContextRef.current?.close();
    }
    analysisContextRef.current = null;
    analysisSinkRef.current = null;
    micSourceRef.current = null;
    remoteSourceRef.current = null;
    micAnalyserRef.current = null;
    remoteAnalyserRef.current = null;
    micVolumeBufferRef.current = null;
    remoteVolumeBufferRef.current = null;
    remoteParticipantRef.current = null;
  }, []);

  const attachVolumeAnalyser = useCallback((side: 'mic' | 'remote', mediaTrack: MediaStreamTrack) => {
    let context = analysisContextRef.current;
    if (!context || context.state === 'closed') {
      context = new AudioContext();
      const silentSink = context.createGain();
      silentSink.gain.value = 0;
      silentSink.connect(context.destination);
      analysisContextRef.current = context;
      analysisSinkRef.current = silentSink;
    }
    if (context.state === 'suspended') void context.resume();

    const sourceRef = side === 'mic' ? micSourceRef : remoteSourceRef;
    const analyserRef = side === 'mic' ? micAnalyserRef : remoteAnalyserRef;
    const bufferRef = side === 'mic' ? micVolumeBufferRef : remoteVolumeBufferRef;
    sourceRef.current?.disconnect();
    analyserRef.current?.disconnect();

    const source = context.createMediaStreamSource(new MediaStream([mediaTrack]));
    const analyser = context.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.72;
    source.connect(analyser);
    analyser.connect(analysisSinkRef.current!);
    sourceRef.current = source;
    analyserRef.current = analyser;
    bufferRef.current = new Uint8Array(analyser.frequencyBinCount);
  }, []);

  const readVolume = useCallback((side: 'mic' | 'remote'): number => {
    const analyser = side === 'mic' ? micAnalyserRef.current : remoteAnalyserRef.current;
    const buffer = side === 'mic' ? micVolumeBufferRef.current : remoteVolumeBufferRef.current;
    if (!analyser || !buffer) return 0;
    analyser.getByteFrequencyData(buffer as Uint8Array<ArrayBuffer>);
    let total = 0;
    for (let index = 0; index < buffer.length; index++) total += buffer[index]!;
    return total / buffer.length / 255;
  }, []);

  const getMicVolume = useCallback(
    () => Math.max(readVolume('mic'), roomRef.current?.localParticipant.audioLevel ?? 0),
    [readVolume],
  );
  const getRemoteVolume = useCallback(
    () => Math.max(readVolume('remote'), remoteParticipantRef.current?.audioLevel ?? 0),
    [readVolume],
  );

  const connect = useCallback(async (session: LiveKitVoiceSession) => {
    setCallStatus('connecting');
    setMicError(null);
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      participant: RemoteParticipant,
    ) => {
      if (track.kind !== Track.Kind.Audio) return;
      remoteParticipantRef.current = participant;
      const element = track.attach();
      element.autoplay = true;
      element.muted = !isSpeakerOn;
      element.style.display = 'none';
      document.body.appendChild(element);
      audioElementsRef.current.push(element);
      attachVolumeAnalyser('remote', track.mediaStreamTrack);
    });
    room.on(RoomEvent.ParticipantAttributesChanged, (changed, participant) => {
      if (participant === room.localParticipant) return;
      const state = changed['lk.agent.state'];
      if (state && agentStates.has(state as FelicityState)) setFelicityState(state as FelicityState);
    });
    room.on(RoomEvent.Disconnected, () => {
      setCallStatus('ended');
      setMicActive(false);
      cleanupAudio();
      cleanupAnalysis();
    });

    try {
      await room.connect(session.url, session.token, { autoSubscribe: true });
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true);
      const microphoneTrack = room.localParticipant.getTrackPublication(Track.Source.Microphone)?.track;
      if (microphoneTrack) attachVolumeAnalyser('mic', microphoneTrack.mediaStreamTrack);
      setMicActive(true);
      setCallStatus('active');
      setFelicityState('listening');
    } catch (error) {
      setMicError(error instanceof Error ? error.message : '無法啟動麥克風');
      setCallStatus('error');
      await room.disconnect();
      throw error;
    }
  }, [attachVolumeAnalyser, cleanupAnalysis, cleanupAudio, isSpeakerOn]);

  const hangUp = useCallback(() => {
    void roomRef.current?.disconnect();
    roomRef.current = null;
    cleanupAudio();
    cleanupAnalysis();
    setMicActive(false);
    setCallStatus('ended');
  }, [cleanupAnalysis, cleanupAudio]);

  const toggleMute = useCallback(() => {
    const next = !isMuted;
    setIsMuted(next);
    void roomRef.current?.localParticipant.setMicrophoneEnabled(!next).then(() => setMicActive(!next));
  }, [isMuted]);

  const toggleSpeaker = useCallback(() => {
    const next = !isSpeakerOn;
    setIsSpeakerOn(next);
    for (const element of audioElementsRef.current) element.muted = !next;
  }, [isSpeakerOn]);

  useEffect(() => () => {
    void roomRef.current?.disconnect();
    cleanupAudio();
    cleanupAnalysis();
  }, [cleanupAnalysis, cleanupAudio]);

  return {
    callStatus,
    felicityState,
    micActive,
    micError,
    isMuted,
    isSpeakerOn,
    connect,
    hangUp,
    toggleMute,
    toggleSpeaker,
    getMicVolume,
    getRemoteVolume,
  };
}
