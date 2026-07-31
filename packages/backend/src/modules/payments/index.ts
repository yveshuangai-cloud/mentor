import type { PaymentProvider } from './provider.js'
import { linePayProvider } from './linepay.js'

/**
 * Provider 註冊表。藍新／綠界之後照 PaymentProvider 介面實作、加進來即可：
 *
 *   // newebpay.ts — 藍新：MPG 交易，AES-256-CBC 加密 TradeInfo + SHA256 TradeSha，
 *   //               Notify 回調驗 TradeSha 後解密取 Status==='SUCCESS'
 *   // ecpay.ts    — 綠界：AioCheckOut，CheckMacValue（SHA256）驗簽，
 *   //               ReturnURL 回調驗 CheckMacValue 後取 RtnCode===1
 */
const providers: PaymentProvider[] = [linePayProvider]

export function getProvider(name: string): PaymentProvider {
  const p = providers.find((x) => x.name === name)
  if (!p) throw new Error(`unknown payment provider: ${name}`)
  if (!p.isConfigured()) throw new Error(`payment provider not configured: ${name}`)
  return p
}

export function listConfiguredProviders(): string[] {
  return providers.filter((p) => p.isConfigured()).map((p) => p.name)
}
