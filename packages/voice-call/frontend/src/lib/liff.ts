/**
 * LIFF SDK 初始化 + 身分識別
 *
 * LIFF 開啟時自動取得 LINE userId，
 * 後端用這個 userId 比對 users 表來辨識是誰打來的。
 */

import liff from '@line/liff';

const LIFF_ID = import.meta.env.VITE_LIFF_ID as string;

export interface LiffProfile {
  userId: string;
  displayName: string;
  pictureUrl?: string;
}

let _initialized = false;
let _profile: LiffProfile | null = null;

/**
 * 初始化 LIFF SDK
 * - 在 LINE 內開啟會自動登入
 * - 在外部瀏覽器會跳轉到 LINE Login
 */
export async function initLiff(): Promise<void> {
  if (_initialized) return;

  if (!LIFF_ID) {
    console.warn('⚠️ VITE_LIFF_ID 未設定，使用 mock 模式');
    _initialized = true;
    return;
  }

  await liff.init({ liffId: LIFF_ID });
  _initialized = true;

  // 如果不在 LINE 內且未登入 → 跳轉登入
  if (!liff.isLoggedIn()) {
    liff.login();
    return;
  }
}

/**
 * 取得 LINE 用戶 profile
 */
export async function getLiffProfile(): Promise<LiffProfile> {
  if (_profile) return _profile;

  // Mock 模式（開發用）
  if (!LIFF_ID) {
    _profile = {
      userId: 'dev-user-001',
      displayName: '開發測試',
      pictureUrl: undefined,
    };
    return _profile;
  }

  const profile = await liff.getProfile();
  _profile = {
    userId: profile.userId,
    displayName: profile.displayName,
    pictureUrl: profile.pictureUrl,
  };
  return _profile;
}

/**
 * 關閉 LIFF 視窗（回到 LINE 聊天室）
 */
export function closeLiff(): void {
  if (LIFF_ID && liff.isInClient()) {
    liff.closeWindow();
  } else {
    window.close();
  }
}

/**
 * 從 URL 取得 session_id 參數
 */
export function getSessionId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('session_id');
}
