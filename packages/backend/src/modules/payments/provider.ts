/**
 * 金流 provider 可插拔介面（交接書 §8）：
 * LINE Pay 先上線；藍新（NewebPay）／綠界（ECPay）照同一介面實作、設定好即可開關。
 *
 * 流程：createPayment（建訂單+取得付款網址）→ 用戶付款 → handleCallback（驗證回調）
 *      → 成功 → points.grantPoints() 入點（記到期日）→ 帳本留痕。
 */

export interface CreatePaymentInput {
  tenantId: number
  orderId: string      // 我方訂單號（唯一）
  amountTwd: number
  points: number
  /** 付款完成後 provider 要導回/回調的 URL（由平台組好傳入） */
  confirmUrl: string
  cancelUrl: string
}

export interface CreatePaymentResult {
  /** 給用戶開啟的付款網址 */
  paymentUrl: string
  /** provider 端交易識別（之後 confirm 用） */
  providerTxn?: string
}

export interface CallbackResult {
  orderId: string
  ok: boolean
  providerTxn?: string
  raw: unknown
}

export interface PaymentProvider {
  readonly name: 'linepay' | 'newebpay' | 'ecpay'
  /** 此 provider 是否已設定齊全（沒設定就不出現在選項裡） */
  isConfigured(): boolean
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>
  /** 驗證並解析回調（含簽章驗證；驗不過一律 ok=false，不入點） */
  handleCallback(payload: unknown, headers: Record<string, string | undefined>): Promise<CallbackResult>
}
