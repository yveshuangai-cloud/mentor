import { createHmac, randomUUID } from 'node:crypto'
import { config } from '../../config.js'
import type {
  CallbackResult,
  CreatePaymentInput,
  CreatePaymentResult,
  PaymentProvider,
} from './provider.js'

/**
 * LINE Pay v3 Online API。
 * 文件流程：Request API（建立交易、取得 paymentUrl）→ 用戶授權 → Confirm API（confirmUrl 收到 transactionId 後確認扣款）。
 * 簽章：HMAC-SHA256(channelSecret, channelSecret + uri + body + nonce)，帶在 X-LINE-Authorization。
 */

const HOST_SANDBOX = 'https://sandbox-api-pay.line.me'
const HOST_PROD = 'https://api-pay.line.me'

function host(): string {
  return config.linepaySandbox ? HOST_SANDBOX : HOST_PROD
}

function sign(uri: string, body: string, nonce: string): string {
  const message = config.linepayChannelSecret + uri + body + nonce
  return createHmac('sha256', config.linepayChannelSecret).update(message).digest('base64')
}

async function linePayPost<T>(uri: string, payload: unknown): Promise<T> {
  const body = JSON.stringify(payload)
  const nonce = randomUUID()
  const res = await fetch(`${host()}${uri}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-LINE-ChannelId': config.linepayChannelId,
      'X-LINE-Authorization-Nonce': nonce,
      'X-LINE-Authorization': sign(uri, body, nonce),
    },
    body,
  })
  if (!res.ok) throw new Error(`LINE Pay ${uri} HTTP ${res.status}`)
  return (await res.json()) as T
}

interface LinePayRequestResponse {
  returnCode: string
  returnMessage: string
  info?: { paymentUrl: { web: string; app: string }; transactionId: string }
}

interface LinePayConfirmResponse {
  returnCode: string
  returnMessage: string
  info?: { transactionId: string; orderId: string }
}

export const linePayProvider: PaymentProvider = {
  name: 'linepay',

  isConfigured(): boolean {
    return config.linepayChannelId !== 'not-configured' && config.linepayChannelSecret !== 'not-configured'
  },

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    const res = await linePayPost<LinePayRequestResponse>('/v3/payments/request', {
      amount: input.amountTwd,
      currency: 'TWD',
      orderId: input.orderId,
      packages: [
        {
          id: 'points',
          amount: input.amountTwd,
          name: '漫漫點數包',
          products: [{ name: `漫漫點數 ${input.points} 點`, quantity: 1, price: input.amountTwd }],
        },
      ],
      redirectUrls: { confirmUrl: input.confirmUrl, cancelUrl: input.cancelUrl },
    })
    if (res.returnCode !== '0000' || !res.info) {
      throw new Error(`LINE Pay request failed: ${res.returnCode} ${res.returnMessage}`)
    }
    return { paymentUrl: res.info.paymentUrl.web, providerTxn: res.info.transactionId }
  },

  /**
   * LINE Pay 的「回調」是使用者被導回 confirmUrl（帶 transactionId + orderId query），
   * 我方需再呼叫 Confirm API 完成扣款——付款成敗以 Confirm 結果為準。
   * payload: { transactionId, orderId, amountTwd }
   */
  async handleCallback(payload: unknown): Promise<CallbackResult> {
    const p = payload as { transactionId?: string; orderId?: string; amountTwd?: number }
    if (!p.transactionId || !p.orderId || !p.amountTwd) {
      return { orderId: p.orderId ?? '', ok: false, raw: payload }
    }
    const res = await linePayPost<LinePayConfirmResponse>(
      `/v3/payments/${p.transactionId}/confirm`,
      { amount: p.amountTwd, currency: 'TWD' },
    )
    return {
      orderId: p.orderId,
      ok: res.returnCode === '0000',
      providerTxn: p.transactionId,
      raw: res,
    }
  },
}
