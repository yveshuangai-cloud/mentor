/**
 * 🔧 Voice Utils — TTS 前處理 + 技術洩漏偵測 + audio format 工具
 *
 * 從 voice-pipeline.ts 抽出來的獨立 module — P1 第四個 extraction
 * 2026-06-17 重構：純函式 + 純常數，邏輯不動
 *
 * 三個獨立 utility：
 *   - stripLeadingInterjection: 去掉 AI 回覆開頭語氣詞（防跟 filler 思考音疊加）
 *   - containsTechLeak: 偵測 AI 是否說了「MiniMax / TTS / 語音引擎」等技術詞
 *   - pcmToWav: 16kHz mono PCM buffer → WAV format（給 Whisper batch 用）
 */

// ============ 語音 TTS 前處理 ============

/**
 * 去除第一句開頭的無意義語氣詞（防止跟 filler 思考音疊加）
 * Filler 已經播了「嗯...」，Claude 回覆再加「嗯，」會變成雙重嗯嗯
 */
export function stripLeadingInterjection(text: string): string {
  // 匹配開頭的語氣詞 + 標點：嗯、嗯嗯、嗚、嗚嗚、唔、恩、啊、哦、呃 + 後接的標點/空格
  const stripped = text.replace(
    /^[嗯恩嗚唔啊哦呃嗯嗯嗚嗚]+[,，、。.…~～\s]*/,
    '',
  ).trim();
  // 如果去掉後還有內容就用清理後的版本，否則保留原文（避免整句被刪光）
  return stripped.length >= 2 ? stripped : text;
}

/**
 * 偵測 AI 回覆是否洩漏技術詞彙（Claude 有時會打破第四面牆）
 * 返回 true = 有技術詞洩漏，應該攔截
 */
const TECH_LEAK_PATTERNS = [
  /eleven\s?labs/i,
  /minimax/i,
  /(?:TTS|ASR|STT)(?:[,，。\s]|$)/,
  /語音(?:引擎|合成|辨識|轉文字|模型)/,
  /文字轉語音/,
  /(?:voice|speech)\s*(?:engine|model|id|synthesis)/i,
  /whisper/i,
  /deepgram/i,
  /(?:用|換|接|串)\s*(?:ElevenLabs|Minimax|Claude|GPT)/i,
  /聲紋\s*(?:ID|設定)/,
  /streaming\s*(?:mode|模式)/i,
];

export function containsTechLeak(text: string): boolean {
  return TECH_LEAK_PATTERNS.some((p) => p.test(text));
}

// ============ 音訊格式工具 ============

/**
 * PCM 16-bit raw buffer → WAV format (with 44-byte header)
 * 給 Whisper batch STT 用（Whisper 不收 raw PCM，需要 WAV 包裝）
 */
export function pcmToWav(
  pcmBuffer: Buffer,
  sampleRate: number,
  bitsPerSample: number,
  channels: number,
): Buffer {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const wav = Buffer.alloc(44 + dataSize);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + dataSize, 4);
  wav.write('WAVE', 8);
  wav.write('fmt ', 12);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(byteRate, 28);
  wav.writeUInt16LE(blockAlign, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(dataSize, 40);
  pcmBuffer.copy(wav, 44);
  return wav;
}
