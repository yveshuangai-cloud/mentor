import { generateImage, geminiConfigured } from './gemini.js'
import { ffmpegConvert, uploadMedia } from './voice.js'

/**
 * 她的畫畫能力（[IMAGE_GEN|…] 技能的執行端）：
 * 確定性抽取 → Gemini 生圖 → 縮圖（LINE preview ≤1MB 規格）→ GCS。
 * 病根紀律：她「說畫好了」不算數，這裡真的生出圖、真的送到 LINE 才算。
 */

const IMAGE_TAG_RE = /\[IMAGE_GEN\|([^\]]+)\]/g

// 她的樣子（persona 底層鎖定）——畫到自己時自動釘上，避免每次長得不一樣
const SELF_APPEARANCE =
  '（角色設定：短黑髮側分瀏海的小女孩，圓臉白皮膚，大而圓的溫暖深色眼睛，淺淺甜笑，戴粉紅色毛球耳朵髮箍，常穿灰色連帽外套，臉上乾淨無彩繪）'
const SELF_RE = /我|自己|饅頭/

export interface ExtractedImages {
  cleanText: string
  prompts: string[]
}

/** 確定性抽取 [IMAGE_GEN|…]（每則回覆最多 1 張，生圖最貴、防灑） */
export function extractImageTags(reply: string): ExtractedImages {
  const prompts: string[] = []
  const cleanText = reply
    .replace(IMAGE_TAG_RE, (_m, inner: string) => {
      if (prompts.length >= 1) return ''
      let p = String(inner).trim()
      if (p && SELF_RE.test(p)) p += SELF_APPEARANCE
      if (p) prompts.push(p)
      return ''
    })
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { cleanText, prompts }
}

/** 一條龍：prompt → LINE image 訊息要的 {originalUrl, previewUrl} */
export async function promptToLineImage(prompt: string): Promise<{ originalUrl: string; previewUrl: string }> {
  const png = await generateImage(prompt)
  // LINE 規格：original ≤10MB、preview ≤1MB——original 轉 jpeg 壓一層、preview 縮到 360 寬
  const originalJpg = await ffmpegConvert(png, 'png', 'jpg', ['-q:v', '4'])
  const previewJpg = await ffmpegConvert(png, 'png', 'jpg', ['-vf', 'scale=360:-1', '-q:v', '6'])
  const originalUrl = await uploadMedia(originalJpg, 'image/jpeg', 'jpg', 'cards')
  const previewUrl = await uploadMedia(previewJpg, 'image/jpeg', 'jpg', 'cards')
  return { originalUrl, previewUrl }
}

export function imageGenConfigured(): boolean {
  return geminiConfigured()
}
