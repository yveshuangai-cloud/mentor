import { config } from '../config.js'
import { forTenant } from '../db/tenantDb.js'
import { platformQuery } from '../db/index.js'
import { loadCharacterCore, loadFamilyBridge } from './soul/loader.js'
import { renderBiography } from './soul/biography.js'
import { loadMemoryBlocks } from './memory/recall.js'
import type { TenantRow, MemberRow, UserRow } from './tenancy.js'

/**
 * 大腦（v1 精簡版）：組 prompt（🟢 core + 🟡 biography + 近期對話）→ 呼叫 Claude。
 * 路由：純文字 → bridge（BRIDGE_SECRET 有值時，吃 Max 月費）；
 *       帶附件（讀圖/讀 PDF）→ 一律直連 API（bridge 只吃純文字）。
 * 本尊的五層記憶/蒸餾/主動等管線之後逐步搬入；此版先立正確的組裝骨架與租戶隔離。
 */

export interface BrainAttachment {
  kind: 'image' | 'document'
  mediaType: string // image/jpeg、image/png、application/pdf
  base64: string
}

export interface BrainInput {
  tenant: TenantRow
  user: UserRow
  member: MemberRow
  message: string
  attachment?: BrainAttachment
}

export interface BrainOutput {
  reply: string
}

const HISTORY_LIMIT = 20

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'document'; source: { type: 'base64'; media_type: string; data: string } }

export async function processMessage(input: BrainInput): Promise<BrainOutput> {
  const { tenant, user, message, attachment } = input
  const db = forTenant(tenant.id)

  const [soul, biography, memory, historyRes] = await Promise.all([
    loadCharacterCore(),
    renderBiography(tenant),
    loadMemoryBlocks(tenant.id),
    db.query<{ user_message: string | null; ai_response: string | null }>(
      `SELECT user_message, ai_response FROM conversations
       WHERE tenant_id = $1 AND user_id = $2
       ORDER BY created_at DESC LIMIT ${HISTORY_LIMIT}`,
      [user.id],
    ),
  ])

  const familyBridge = tenant.mode === 'family' ? await loadFamilyBridge() : ''
  const system = [
    soul.preBiography,
    `# 我的傳記（只屬於這一戶，絕無別人的）\n\n${biography}`,
    memory.distilledEssence,
    memory.topicIndex,
    memory.learnedKnowledge,
    soul.postBiography,
    familyBridge,
    soul.skills,
    `# 現在\n- 時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台北）`,
  ]
    .filter(Boolean)
    .join('\n\n===\n\n')

  const history = historyRes.rows.reverse()
  const messages: { role: 'user' | 'assistant'; content: string | ContentBlock[] }[] = []
  for (const h of history) {
    if (h.user_message) messages.push({ role: 'user', content: h.user_message })
    if (h.ai_response) messages.push({ role: 'assistant', content: h.ai_response })
  }
  if (attachment) {
    const mediaBlock: ContentBlock =
      attachment.kind === 'image'
        ? { type: 'image', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.base64 } }
        : { type: 'document', source: { type: 'base64', media_type: attachment.mediaType, data: attachment.base64 } }
    messages.push({ role: 'user', content: [mediaBlock, { type: 'text', text: message }] })
  } else {
    messages.push({ role: 'user', content: message })
  }

  // 附件必走直連 API（bridge 是 CLI stdin，吃不了多模態）
  const useBridge = config.bridgeSecret !== '' && !attachment
  const hasApiKey = config.anthropicApiKey !== 'not-configured'
  if (!useBridge && !hasApiKey) {
    return {
      reply: attachment
        ? '我看到你傳來的東西了……但我看圖的眼睛還沒接上（需要設定 ANTHROPIC_API_KEY）。'
        : '嗯，我聽到了。（我的腦還沒接上——請先設定 BRIDGE_SECRET 或 ANTHROPIC_API_KEY）',
    }
  }

  // bridge 契約：只讀 model/system/messages，system 要純字串（cache_control 區塊給直連 API 用）
  // llmBaseUrl 只屬於 bridge 路徑；直連（含附件強制直連）永遠打 api.anthropic.com，不吃這個 env
  const apiBase = useBridge ? config.llmBaseUrl : 'https://api.anthropic.com'
  const res = await fetch(`${apiBase}/v1/messages`, {
    method: 'POST',
    headers: useBridge
      ? { 'content-type': 'application/json', authorization: `Bearer ${config.bridgeSecret}` }
      : {
          'content-type': 'application/json',
          'x-api-key': config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
    body: JSON.stringify({
      model: config.brainModel,
      max_tokens: 800,
      system: useBridge
        ? system
        : [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
      messages,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`Anthropic API HTTP ${res.status}: ${body.slice(0, 300)}`)
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }

  // 成本錶：每次動腦落一筆（bridge = Max 月費記 0 元；直連 API 記估算金額）
  void logLlmCost(tenant.id, useBridge, attachment ? 'chat:vision' : 'chat', data.usage).catch(() => {})

  const reply = data.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('')
    .trim()
  return { reply: stripVoiceMarkers(reply) || '嗯，我在這裡。' }
}

/** 估算單價（USD / 1M tokens）——只到「量級對」，精確對帳以 Anthropic console 為準 */
const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
}

async function logLlmCost(
  tenantId: number,
  viaBridge: boolean,
  purpose: string,
  usage?: { input_tokens?: number; output_tokens?: number },
): Promise<void> {
  const tokensIn = usage?.input_tokens ?? 0
  const tokensOut = usage?.output_tokens ?? 0
  const price = PRICE_PER_M[config.brainModel]
  const costUsd = viaBridge || !price ? 0 : (tokensIn * price.in + tokensOut * price.out) / 1_000_000
  await platformQuery(
    `INSERT INTO llm_cost_log (tenant_id, model, purpose, tokens_input, tokens_output, cost_usd, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      tenantId,
      config.brainModel,
      purpose,
      tokensIn,
      tokensOut,
      costUsd,
      JSON.stringify({ via: viaBridge ? 'bridge' : 'api' }),
    ],
  )
}

/** 語音停頓標記（voice-dna 範例的 <#秒#>）只給語音管線用；文字通道在咽喉確定性剝除，不靠模型自律 */
function stripVoiceMarkers(text: string): string {
  return text
    .replace(/<#[\d.]+#>/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
}
