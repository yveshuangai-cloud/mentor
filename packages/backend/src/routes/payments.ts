import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { platformQuery } from '../db/index.js'
import { getProvider } from '../modules/payments/index.js'
import { grantPoints } from '../modules/points.js'
import { config } from '../config.js'

/**
 * 金流（§8）：選點數包 → provider 付款 → 回調入點（記到期日）→ 帳本留痕。
 * v1 點數包：定價未定（§14），先讀 system_settings.point_packages，預設 1000 點。
 */

interface PointPackage {
  points: number
  amount_twd: number
  expire_days: number
}

async function getPackages(): Promise<PointPackage[]> {
  const res = await platformQuery<{ value: PointPackage[] }>(
    `SELECT value FROM system_settings WHERE key = 'point_packages'`,
  )
  if (res.rowCount && Array.isArray(res.rows[0].value)) return res.rows[0].value
  // 定價未定：預設一包（金額待定案後由後台調 system_settings）
  return [{ points: 1000, amount_twd: 299, expire_days: 90 }]
}

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  app.get('/packages', async () => ({ packages: await getPackages() }))

  // 建立付款（回傳 paymentUrl 給用戶開啟）
  app.post<{ Body: { tenantId: number; packageIndex?: number; provider?: string } }>(
    '/create',
    async (req, reply) => {
      const { tenantId, packageIndex = 0, provider: providerName = 'linepay' } = req.body ?? {}
      if (!tenantId) return reply.code(400).send({ error: 'tenantId required' })
      const packages = await getPackages()
      const pkg = packages[packageIndex]
      if (!pkg) return reply.code(400).send({ error: 'bad packageIndex' })

      const provider = getProvider(providerName)
      const orderId = `MMP-${Date.now()}-${randomUUID().slice(0, 8)}`
      await platformQuery(
        `INSERT INTO payments (tenant_id, provider, order_id, amount_twd, points, status)
         VALUES ($1, $2, $3, $4, $5, 'pending')`,
        [tenantId, provider.name, orderId, pkg.amount_twd, pkg.points],
      )
      const created = await provider.createPayment({
        tenantId,
        orderId,
        amountTwd: pkg.amount_twd,
        points: pkg.points,
        confirmUrl: `${config.publicBaseUrl}/api/payments/linepay/confirm?orderId=${orderId}`,
        cancelUrl: `${config.publicBaseUrl}/api/payments/cancel?orderId=${orderId}`,
      })
      await platformQuery(`UPDATE payments SET provider_txn = $2 WHERE order_id = $1`, [
        orderId,
        created.providerTxn ?? null,
      ])
      return { orderId, paymentUrl: created.paymentUrl }
    },
  )

  // LINE Pay 導回：confirm 完成扣款 → 入點
  app.get<{ Querystring: { orderId?: string; transactionId?: string } }>(
    '/linepay/confirm',
    async (req, reply) => {
      const { orderId, transactionId } = req.query
      if (!orderId || !transactionId) return reply.code(400).send({ error: 'missing params' })

      const payRes = await platformQuery<{
        id: number
        tenant_id: number
        amount_twd: number
        points: number
        status: string
      }>(`SELECT id, tenant_id, amount_twd, points, status FROM payments WHERE order_id = $1`, [orderId])
      if (!payRes.rowCount) return reply.code(404).send({ error: 'order not found' })
      const payment = payRes.rows[0]
      if (payment.status === 'paid') return reply.send({ ok: true, note: 'already paid' }) // 冪等

      const provider = getProvider('linepay')
      const result = await provider.handleCallback(
        { transactionId, orderId, amountTwd: payment.amount_twd },
        {},
      )
      await platformQuery(
        `UPDATE payments SET status = $2, raw_callback = $3, provider_txn = $4, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END
         WHERE order_id = $1`,
        [orderId, result.ok ? 'paid' : 'failed', JSON.stringify(result.raw), result.providerTxn ?? null],
      )
      if (!result.ok) return reply.code(402).send({ ok: false })

      const granted = await grantPoints(payment.tenant_id, payment.points, {
        reason: 'purchase',
        source: 'purchase',
        paymentId: payment.id,
        refType: 'payment',
        refId: orderId,
      })
      return reply.send({ ok: true, balance: granted.balance, expireAt: granted.expireAt })
    },
  )

  app.get<{ Querystring: { orderId?: string } }>('/cancel', async (req) => {
    if (req.query.orderId) {
      await platformQuery(
        `UPDATE payments SET status = 'failed' WHERE order_id = $1 AND status = 'pending'`,
        [req.query.orderId],
      )
    }
    return { ok: true, cancelled: true }
  })
}
