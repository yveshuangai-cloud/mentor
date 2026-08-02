import { config } from '../config.js'
import { forTenant } from '../db/tenantDb.js'
import { loadCharacterCore, loadFamilyBridge } from './soul/loader.js'
import { renderBiography } from './soul/biography.js'
import type { TenantRow, MemberRow, UserRow } from './tenancy.js'

/**
 * 大腦（v1 精簡版）：組 prompt（🟢 core + 🟡 biography + 近期對話）→ 呼叫 Claude。
 * 本尊的五層記憶/蒸餾/主動等管線之後逐步搬入；此版先立正確的組裝骨架與租戶隔離。
 */

export interface BrainInput {
  tenant: TenantRow
  user: UserRow
  member: MemberRow
  message: string
}

export interface BrainOutput {
  reply: string
}

const HISTORY_LIMIT = 20

export async function processMessage(input: BrainInput): Promise<BrainOutput> {
  const { tenant, user, message } = input
  const db = forTenant(tenant.id)

  const [soul, biography, historyRes] = await Promise.all([
    loadCharacterCore(),
    renderBiography(tenant),
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
    soul.postBiography,
    familyBridge,
    soul.skills,
    `# 現在\n- 時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}（台北）`,
  ]
    .filter(Boolean)
    .join('\n\n===\n\n')

  const history = historyRes.rows.reverse()
  const messages: { role: 'user' | 'assistant'; content: string }[] = []
  for (const h of history) {
    if (h.user_message) messages.push({ role: 'user', content: h.user_message })
    if (h.ai_response) messages.push({ role: 'assistant', content: h.ai_response })
  }
  messages.push({ role: 'user', content: message })

  const useBridge = config.bridgeSecret !== ''
  if (!useBridge && config.anthropicApiKey === 'not-configured') {
    return { reply: '嗯，我聽到了。（我的腦還沒接上——請先設定 BRIDGE_SECRET 或 ANTHROPIC_API_KEY）' }
  }

  // bridge 契約：只讀 model/system/messages，system 要純字串（cache_control 區塊給直連 API 用）
  const res = await fetch(`${config.llmBaseUrl}/v1/messages`, {
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
  const data = (await res.json()) as { content: { type: string; text?: string }[] }
  const reply = data.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('')
    .trim()
  return { reply: stripVoiceMarkers(reply) || '嗯，我在這裡。' }
}

/** 語音停頓標記（voice-dna 範例的 <#秒#>）只給語音管線用；文字通道在咽喉確定性剝除，不靠模型自律 */
function stripVoiceMarkers(text: string): string {
  return text
    .replace(/<#[\d.]+#>/g, '')
    .replace(/[^\S\n]{2,}/g, ' ')
    .trim()
}
