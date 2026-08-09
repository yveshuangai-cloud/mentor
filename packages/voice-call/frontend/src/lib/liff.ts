import liff from '@line/liff';

export interface LiffProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

export interface WebSocketVoiceSession {
  transport: 'websocket';
  sessionId: string;
  token: string;
  websocketPath: string;
}

export interface LiveKitVoiceSession {
  transport: 'livekit';
  sessionId: string;
  token: string;
  url: string;
  roomName: string;
}

export type VoiceSession = WebSocketVoiceSession | LiveKitVoiceSession;

let initialized = false;
let profile: LiffProfile | null = null;

async function loadLiffId(): Promise<string> {
  const response = await fetch('/api/voice-call/public-config');
  if (!response.ok) throw new Error('無法讀取通話設定。');
  const config = await response.json() as { liffId?: string | null };
  if (!config.liffId) throw new Error('LINE 通話入口尚未完成設定。');
  return config.liffId;
}

export async function initLiff(): Promise<void> {
  if (initialized) return;
  const liffId = await loadLiffId();
  await liff.init({ liffId });
  initialized = true;
  if (!liff.isLoggedIn()) {
    liff.login({ redirectUri: window.location.href });
    throw new Error('正在前往 LINE 登入…');
  }
}

export async function getLiffProfile(): Promise<LiffProfile> {
  if (profile) return profile;
  const result = await liff.getProfile();
  profile = {
    userId: result.userId,
    displayName: result.displayName,
    pictureUrl: result.pictureUrl,
  };
  return profile;
}

export async function createVoiceSession(): Promise<VoiceSession> {
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error('LINE 身分驗證已失效，請重新開啟通話。');
  const response = await fetch('/api/voice-call/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ idToken }),
  });
  if (!response.ok) throw new Error('無法建立安全通話，請稍後再試。');
  return response.json() as Promise<VoiceSession>;
}

export function closeLiff(): void {
  if (liff.isInClient()) liff.closeWindow();
  else window.close();
}
