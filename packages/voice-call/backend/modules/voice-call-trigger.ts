/**
 * 語音通話觸發器 — Flex Message 撥號卡片
 *
 * 偵測關鍵字 → 推送「撥號」Flex Message 給用戶
 * 用戶點按鈕 → 開啟 LIFF 全螢幕通話介面
 */

import { config } from '../config.js';

// ============ 觸發關鍵字 ============

const CALL_TRIGGER_KEYWORDS_ZH = [
  '想聽妳聲音', '想聽你聲音', '想聽你的聲音', '想聽妳的聲音',
  '打給妳', '打給你', '打電話', '打電話給你', '打電話給妳',
  '包容電話', '小容電話', '語音通話', '即時通話', '通語音', '通話',
  '想跟你說話', '想跟妳說話', '想跟妳講話', '想跟你講話',
  '跟你講電話', '跟妳講電話', '想打給你', '想打給妳',
  '打給小容', '打給包容', '跟小容通話', '跟包容通話',
  '跟妳通話', '跟你通話', '想通話',
];

const CALL_TRIGGER_KEYWORDS_EN = [
  'call you', 'call me', 'phone call', 'voice call',
  'wanna talk', 'want to talk', 'hear your voice',
  'let me hear you', "let's talk",
];

/**
 * 偵測訊息是否觸發語音通話
 */
export function isCallTrigger(text: string): boolean {
  const lower = text.toLowerCase().trim();

  for (const kw of CALL_TRIGGER_KEYWORDS_ZH) {
    if (lower.includes(kw)) return true;
  }
  for (const kw of CALL_TRIGGER_KEYWORDS_EN) {
    if (lower.includes(kw)) return true;
  }

  return false;
}

// ============ Flex Message ============

interface FlexMessageOptions {
  /** 顯示名稱（依租戶成員稱呼） */
  userName: string;
  /** LINE userId（傳到 LIFF 用於身分比對） */
  lineUserId: string;
  /** 包容頭像 URL（可選） */
  avatarUrl?: string;
}

/**
 * 生成撥號 Flex Message
 *
 * 卡片包含：
 * - 包容頭像
 * - 個人化文字（「〈稱呼〉，我想聽你的聲音」）
 * - 撥號按鈕 → 開啟 LIFF
 */
export function createCallFlexMessage(options: FlexMessageOptions) {
  const { userName, lineUserId, avatarUrl } = options;
  const liffId = config.liffId;

  console.log(`📞 createCallFlexMessage: liffId="${liffId}" (length=${liffId?.length}), userName="${userName}"`);

  if (!liffId) {
    console.warn('⚠️ LIFF_ID 未設定（空字串或 undefined），無法生成撥號 Flex Message');
    return null;
  }

  // 個人化文字
  const title = `${userName}，想跟我說說話嗎？`;
  const subtitle = '點擊下方按鈕，我們直接說話吧 🌸';
  const buttonLabel = '按此撥打電話';

  // LIFF URL（帶 session 參數）
  const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const liffUrl = `line://app/${liffId}?session_id=${sessionId}&uid=${lineUserId}`;

  // Flex Message JSON
  const flexContent: Record<string, unknown> = {
    type: 'bubble',
    size: 'kilo',
    body: {
      type: 'box',
      layout: 'vertical',
      contents: [
        // 頭像
        {
          type: 'box',
          layout: 'vertical',
          contents: [
            {
              type: 'image',
              url: avatarUrl || 'https://pub-REPLACE_ME.r2.dev/avatar.png',
              size: 'xxl',
              aspectMode: 'cover',
              aspectRatio: '1:1',
            },
          ],
          cornerRadius: '100px',
          width: '120px',
          height: '120px',
          offsetStart: 'none',
          offsetEnd: 'none',
          alignItems: 'center',
        },
        // 標題
        {
          type: 'text',
          text: title,
          weight: 'bold',
          size: 'lg',
          align: 'center',
          margin: 'lg',
          wrap: true,
        },
        // 副標題
        {
          type: 'text',
          text: subtitle,
          size: 'xs',
          color: '#888888',
          align: 'center',
          margin: 'md',
          wrap: true,
        },
      ],
      alignItems: 'center',
      paddingAll: '20px',
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'button',
          action: {
            type: 'uri',
            label: buttonLabel,
            uri: liffUrl,
          },
          style: 'primary',
          color: '#E8345A',
          height: 'md',
        },
      ],
      paddingAll: '12px',
    },
  };

  // LINE Messaging API 的 Flex Message 格式
  return {
    type: 'flex' as const,
    altText: `${userName}，點這裡跟我說說話 🌸`,
    contents: flexContent,
  };
}

/**
 * 推送撥號 Flex Message 到 LINE
 */
export async function pushCallFlexMessage(
  targetId: string,
  options: FlexMessageOptions,
  channelToken?: string
): Promise<boolean> {
  const token = channelToken || config.lineChannelToken;
  console.log(`📞 pushCallFlexMessage 開始: targetId=${targetId.slice(0, 12)}…, userName=${options.userName}`);

  const flexMsg = createCallFlexMessage(options);
  if (!flexMsg) {
    console.error('📞 createCallFlexMessage 返回 null — LIFF_ID 可能未設定');
    return false;
  }

  console.log(`📞 Flex Message 已生成，準備推送到 LINE Push API...`);

  try {
    const pushBody = {
      to: targetId,
      messages: [flexMsg],
    };

    const response = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(pushBody),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`📞 撥號 Flex Message 推送失敗 (${response.status}):`, errorText);
      return false;
    }

    console.log(`📞 ✅ 撥號卡片已推送給 ${options.userName} (${targetId})`);
    return true;
  } catch (err) {
    console.error('📞 撥號 Flex Message 推送錯誤:', err);
    return false;
  }
}
