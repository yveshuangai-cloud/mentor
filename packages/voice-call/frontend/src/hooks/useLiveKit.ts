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
  const audioElementsRef = useRef<HTMLMediaElement[]>([]);
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

  const connect = useCallback(async (session: LiveKitVoiceSession) => {
    setCallStatus('connecting');
    setMicError(null);
    const room = new Room({ adaptiveStream: true, dynacast: true });
    roomRef.current = room;

    room.on(RoomEvent.TrackSubscribed, (
      track: RemoteTrack,
      _publication: RemoteTrackPublication,
      _participant: RemoteParticipant,
    ) => {
      if (track.kind !== Track.Kind.Audio) return;
      const element = track.attach();
      element.autoplay = true;
      element.muted = !isSpeakerOn;
      element.style.display = 'none';
      document.body.appendChild(element);
      audioElementsRef.current.push(element);
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
    });

    try {
      await room.connect(session.url, session.token, { autoSubscribe: true });
      await room.startAudio();
      await room.localParticipant.setMicrophoneEnabled(true);
      setMicActive(true);
      setCallStatus('active');
      setFelicityState('listening');
    } catch (error) {
      setMicError(error instanceof Error ? error.message : '無法啟動麥克風');
      setCallStatus('error');
      await room.disconnect();
      throw error;
    }
  }, [cleanupAudio, isSpeakerOn]);

  const hangUp = useCallback(() => {
    void roomRef.current?.disconnect();
    roomRef.current = null;
    cleanupAudio();
    setMicActive(false);
    setCallStatus('ended');
  }, [cleanupAudio]);

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
  }, [cleanupAudio]);

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
  };
}
