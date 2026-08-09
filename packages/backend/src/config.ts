import 'dotenv/config'
import { z } from 'zod'

const blankAsUndefined = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === 'string' && value.trim() === '' ? undefined : value), schema)

const envBoolean = (fallback: boolean) =>
  z.preprocess((value) => {
    if (value == null || value === '') return undefined
    if (typeof value === 'boolean') return value
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(normalized)) return true
      if (['false', '0', 'no', 'off'].includes(normalized)) return false
    }
    return value
  }, z.boolean().default(fallback))

const configSchema = z.object({
  port: blankAsUndefined(z.coerce.number().default(3000)),
  nodeEnv: blankAsUndefined(z.enum(['development', 'test', 'production']).default('development')),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  dbSsl: envBoolean(false),
  jwtSecret: blankAsUndefined(z.string().min(32).default('dev-only-secret-change-me-please-32ch')),

  // 商用 LINE OA（獨立於本尊，絕不共用）
  lineChannelToken: blankAsUndefined(z.string().default('not-configured')),
  lineChannelSecret: blankAsUndefined(z.string().default('not-configured')),
  lineLoginChannelId: blankAsUndefined(z.string().default('not-configured')),
  liffId: blankAsUndefined(z.string().default('not-configured')),
  // 精確 LINE User ID 白名單；只從 Secret Manager 注入，不進程式庫。
  soulAuthorizedLineUserIds: blankAsUndefined(z.string().default('')),

  // LLM（bridgeSecret 有值 → 走 zhu-bridge 吃 Max 月費；否則直連 API 燒 key）
  anthropicApiKey: blankAsUndefined(z.string().default('not-configured')),
  llmBaseUrl: blankAsUndefined(z.string().default('https://api.anthropic.com')),
  bridgeSecret: blankAsUndefined(z.string().default('')),
  brainModel: blankAsUndefined(z.string().default('claude-sonnet-5')),
  extractorModel: blankAsUndefined(z.string().default('claude-haiku-4-5-20251001')),

  // 金流
  linepayChannelId: blankAsUndefined(z.string().default('not-configured')),
  linepayChannelSecret: blankAsUndefined(z.string().default('not-configured')),
  linepaySandbox: envBoolean(true),

  publicBaseUrl: blankAsUndefined(z.string().default('http://localhost:3000')),

  // Cloud Scheduler 打 cron route 用（throttled Cloud Run 上 setInterval 必死）
  cronSecret: blankAsUndefined(z.string().default('')),

  // 饅頭不需要睡覺或做夢；保留旗標只為了可逆地停用舊夜間靈魂模組。
  enableNightSoul: envBoolean(false),

  // MiniMax 克隆聲（[VOICE_GEN] 技能執行端）
  minimaxApiKey: blankAsUndefined(z.string().default('not-configured')),
  // MiniMax 國際版不要求 GroupId；僅舊帳號／舊端點需要時才填。
  minimaxGroupId: blankAsUndefined(z.string().default('')),
  minimaxVoiceId: blankAsUndefined(z.string().default('not-configured')),

  // Real-time speech recognition for the isolated Mantou voice service.
  deepgramApiKey: blankAsUndefined(z.string().default('not-configured')),

  // Dedicated LiveKit Cloud project for Mantou. Never reuse another persona's key pair.
  livekitUrl: blankAsUndefined(z.string().url().default('https://not-configured.invalid')),
  livekitApiKey: blankAsUndefined(z.string().default('not-configured')),
  livekitApiSecret: blankAsUndefined(z.string().default('not-configured')),
  livekitAgentName: blankAsUndefined(z.string().default('mantou-agent')),
  livekitEnabled: envBoolean(false),

  // Gemini（聽音檔 STT＋畫圖生圖執行端）
  geminiApiKey: blankAsUndefined(z.string().default('not-configured')),
  googleCloudProject: blankAsUndefined(z.string().default('project-ed7d5a71-0316-4c2f-896')),
  vertexLocation: blankAsUndefined(z.string().default('global')),
})

const rawConfig = {
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  dbSsl: process.env.DB_SSL,
  jwtSecret: process.env.JWT_SECRET,
  lineChannelToken: process.env.LINE_CHANNEL_TOKEN,
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET,
  lineLoginChannelId: process.env.LINE_LOGIN_CHANNEL_ID,
  liffId: process.env.LIFF_ID,
  soulAuthorizedLineUserIds: process.env.SOUL_AUTHORIZED_LINE_USER_IDS,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  llmBaseUrl: process.env.LLM_BASE_URL,
  bridgeSecret: process.env.BRIDGE_SECRET,
  brainModel: process.env.BRAIN_MODEL,
  extractorModel: process.env.EXTRACTOR_MODEL,
  linepayChannelId: process.env.LINEPAY_CHANNEL_ID,
  linepayChannelSecret: process.env.LINEPAY_CHANNEL_SECRET,
  linepaySandbox: process.env.LINEPAY_SANDBOX,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  cronSecret: process.env.CRON_SECRET,
  enableNightSoul: process.env.ENABLE_NIGHT_SOUL,
  minimaxApiKey: process.env.MINIMAX_API_KEY,
  minimaxGroupId: process.env.MINIMAX_GROUP_ID,
  minimaxVoiceId: process.env.MINIMAX_VOICE_ID,
  deepgramApiKey: process.env.DEEPGRAM_API_KEY,
  livekitUrl: process.env.LIVEKIT_URL?.trim(),
  livekitApiKey: process.env.LIVEKIT_API_KEY?.trim(),
  livekitApiSecret: process.env.LIVEKIT_API_SECRET?.trim(),
  livekitAgentName: process.env.LIVEKIT_AGENT_NAME?.trim(),
  livekitEnabled: process.env.LIVEKIT_ENABLED,
  geminiApiKey: process.env.GEMINI_API_KEY,
  googleCloudProject: process.env.GOOGLE_CLOUD_PROJECT,
  vertexLocation: process.env.VERTEX_LOCATION,
}

export const config = configSchema.parse(rawConfig)

const soulAuthorityIds = new Set(
  config.soulAuthorizedLineUserIds.split(',').map((id) => id.trim()).filter(Boolean),
)

export function isSoulAuthorizedLineUser(lineUserId: string): boolean {
  return soulAuthorityIds.has(lineUserId)
}

/** 上線前的健檢：缺什麼直說，不要靜默失敗（本尊的教訓） */
export function warnMissingConfig(log: (msg: string) => void): void {
  const notConfigured = Object.entries(config)
    .filter(([, v]) => v === 'not-configured')
    .filter(([k]) => !(k === 'anthropicApiKey' && config.bridgeSecret !== ''))
    .map(([k]) => k)
  if (notConfigured.length > 0) {
    log(`⚠️ 未設定的 config（相關功能將停用）: ${notConfigured.join(', ')}`)
  }
}
