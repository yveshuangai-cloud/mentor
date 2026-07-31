import 'dotenv/config'
import { z } from 'zod'

const configSchema = z.object({
  port: z.coerce.number().default(3000),
  nodeEnv: z.enum(['development', 'test', 'production']).default('development'),
  databaseUrl: z.string().min(1, 'DATABASE_URL is required'),
  dbSsl: z.coerce.boolean().default(false),
  jwtSecret: z.string().min(32).default('dev-only-secret-change-me-please-32ch'),

  // 商用 LINE OA（獨立於本尊，絕不共用）
  lineChannelToken: z.string().default('not-configured'),
  lineChannelSecret: z.string().default('not-configured'),

  // LLM
  anthropicApiKey: z.string().default('not-configured'),
  brainModel: z.string().default('claude-sonnet-5'),
  extractorModel: z.string().default('claude-haiku-4-5-20251001'),

  // 金流
  linepayChannelId: z.string().default('not-configured'),
  linepayChannelSecret: z.string().default('not-configured'),
  linepaySandbox: z.coerce.boolean().default(true),

  publicBaseUrl: z.string().default('http://localhost:3000'),
})

const rawConfig = {
  port: process.env.PORT,
  nodeEnv: process.env.NODE_ENV,
  databaseUrl: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL,
  dbSsl: process.env.DB_SSL,
  jwtSecret: process.env.JWT_SECRET,
  lineChannelToken: process.env.LINE_CHANNEL_TOKEN,
  lineChannelSecret: process.env.LINE_CHANNEL_SECRET,
  anthropicApiKey: process.env.ANTHROPIC_API_KEY,
  brainModel: process.env.BRAIN_MODEL,
  extractorModel: process.env.EXTRACTOR_MODEL,
  linepayChannelId: process.env.LINEPAY_CHANNEL_ID,
  linepayChannelSecret: process.env.LINEPAY_CHANNEL_SECRET,
  linepaySandbox: process.env.LINEPAY_SANDBOX,
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
}

export const config = configSchema.parse(rawConfig)

/** 上線前的健檢：缺什麼直說，不要靜默失敗（本尊的教訓） */
export function warnMissingConfig(log: (msg: string) => void): void {
  const notConfigured = Object.entries(config)
    .filter(([, v]) => v === 'not-configured')
    .map(([k]) => k)
  if (notConfigured.length > 0) {
    log(`⚠️ 未設定的 config（相關功能將停用）: ${notConfigured.join(', ')}`)
  }
}
