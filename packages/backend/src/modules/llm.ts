import { config } from '../config.js'
import { platformQuery } from '../db/index.js'

/**
 * 共用 LLM 呼叫（記憶管線等背景任務用）。
 * 路由跟 brain.ts 同一套慣例：BRIDGE_SECRET 有值 → bridge（Max 月費，成本記 0）；
 * 否則直連 API。背景任務都是純文字，兩條路都能走。
 *
 * setLlmOverride()：驗收/測試注入假 LLM，不燒錢、結果確定。
 */

export interface LlmRequest {
  model: string
  system?: string
  messages: { role: 'user' | 'assistant'; content: string }[]
  maxTokens: number
}

export interface LlmResponse {
  text: string
  usage: { input_tokens: number; output_tokens: number }
}

export type LlmFn = (req: LlmRequest) => Promise<LlmResponse>

let override: LlmFn | null = null

/** 測試用：注入假 LLM（null 還原真實呼叫） */
export function setLlmOverride(fn: LlmFn | null): void {
  override = fn
}

export function isLlmConfigured(): boolean {
  return override !== null || config.bridgeSecret !== '' || config.anthropicApiKey !== 'not-configured'
}

const PRICE_PER_M: Record<string, { in: number; out: number }> = {
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5-20251001': { in: 1, out: 5 },
}

export async function callLlm(
  req: LlmRequest,
  meta: { tenantId: number | null; purpose: string },
): Promise<LlmResponse> {
  if (override) return override(req)

  const useBridge = config.bridgeSecret !== ''
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
      model: req.model,
      max_tokens: req.maxTokens,
      ...(req.system ? { system: req.system } : {}),
      messages: req.messages,
    }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`LLM HTTP ${res.status}: ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as {
    content: { type: string; text?: string }[]
    usage?: { input_tokens?: number; output_tokens?: number }
  }
  const text = data.content
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text)
    .join('')
    .trim()
  const usage = {
    input_tokens: data.usage?.input_tokens ?? 0,
    output_tokens: data.usage?.output_tokens ?? 0,
  }

  // 成本錶（bridge = 0；直連記估算）
  const price = PRICE_PER_M[req.model]
  const costUsd = useBridge || !price
    ? 0
    : (usage.input_tokens * price.in + usage.output_tokens * price.out) / 1_000_000
  void platformQuery(
    `INSERT INTO llm_cost_log (tenant_id, model, purpose, tokens_input, tokens_output, cost_usd, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [meta.tenantId, req.model, meta.purpose, usage.input_tokens, usage.output_tokens, costUsd,
     JSON.stringify({ via: useBridge ? 'bridge' : 'api' })],
  ).catch(() => {})

  return { text, usage }
}

/** 從 LLM 回覆抓 JSON（object 或 array；剝 code fence） */
export function extractJson<T>(raw: string, kind: 'object' | 'array'): T | null {
  const text = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
  const open = kind === 'object' ? '{' : '['
  const close = kind === 'object' ? '}' : ']'
  const start = text.indexOf(open)
  const end = text.lastIndexOf(close)
  if (start < 0 || end < 0) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as T
  } catch {
    return null
  }
}
