/**
 * 👂 耳朵模組 — OpenAI Whisper 語音轉文字
 *
 * 負責：
 * - 將用戶的語音訊息轉成文字
 * - 支援多語言偵測
 */

import { config } from '../config.js';
import { query } from '../db/index.js';
import { SOUL } from './soulConfig.js';

/**
 * 將語音轉成文字
 */
export async function transcribeAudio(
  audioBuffer: ArrayBuffer,
  _userId?: number,
  mimeType: string = 'audio/m4a',
  _filename: string = 'audio.m4a'  // 簽名相容；Deepgram 走 mimeType，不需 filename
): Promise<string> {
  // 取得耳朵設定
  const settingsResult = await query(`
    SELECT settings FROM organ_settings
    WHERE user_id IS NULL AND organ_name = 'ear'
  `);
  const settings = settingsResult.rows[0]?.settings || {};

  const language = (settings.language_hint && settings.language_hint !== 'auto')
    ? settings.language_hint : 'zh-TW';

  // 🎤 STT 走 Deepgram nova-3（預錄音批次）— 繞過 OpenAI 額度，跟語音通話同款引擎
  const params = new URLSearchParams({
    model: 'nova-3', language, smart_format: 'true', punctuate: 'true',
  });
  const response = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Authorization': `Token ${config.deepgramApiKey}`,
      'Content-Type': mimeType,
    },
    body: audioBuffer,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Deepgram STT error:', response.status, errorText.slice(0, 200));
    throw new Error(`Deepgram STT error: ${response.status}`);
  }

  const data = await response.json() as {
    results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> };
  };
  const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';

  // 後處理：修正常見的語音辨識錯誤（soul-slot 修正表）
  return correctTranscription(text);
}

/**
 * 從 LINE 下載語音訊息（含 retry 機制）
 *
 * LINE Content API 偶爾回傳 401/5xx，加入重試避免因暫態錯誤遺漏語音
 */
export async function downloadLineAudio(messageId: string, channelToken?: string): Promise<ArrayBuffer> {
  const token = channelToken || config.lineChannelToken;
  const maxRetries = 3;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const response = await fetch(
      `https://api-data.line.me/v2/bot/message/${messageId}/content`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );

    if (response.ok) {
      return response.arrayBuffer();
    }

    // 可重試的 HTTP 狀態碼（401 暫態、5xx 伺服器錯誤）
    const retryable = response.status === 401 || response.status >= 500;
    if (retryable && attempt < maxRetries - 1) {
      const waitMs = 1000 * (attempt + 1);  // 1s, 2s, 3s
      console.warn(`⚠️ LINE audio download attempt ${attempt + 1}/${maxRetries} failed (${response.status}), retrying in ${waitMs}ms...`);
      await new Promise(r => setTimeout(r, waitMs));
      continue;
    }

    throw new Error(`Failed to download LINE audio: ${response.status}`);
  }

  // TypeScript: 不應到達這裡，但需要滿足型別
  throw new Error('Failed to download LINE audio: max retries exceeded');
}

/**
 * 修正常見的語音辨識錯誤
 */
/** @internal exported for testing */
export function correctTranscription(
  text: string,
  corrections: Record<string, string> = SOUL.transcriptionCorrections,
): string {
  // 修正表為 soul-slot（見 soulConfig.transcriptionCorrections）；預設空＝passthrough。
  let corrected = text;
  for (const [wrong, right] of Object.entries(corrections)) {
    corrected = corrected.replace(new RegExp(wrong, 'g'), right);
  }

  return corrected;
}
