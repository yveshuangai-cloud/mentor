import { withTransaction } from '../../db/index.js'
import { grantPointsInTransaction } from '../points.js'

interface PaymentRow {
  id: number
  tenant_id: number
  amount_twd: number
  points: number
  status: string
}

export interface SettlementResult {
  found: boolean
  ok: boolean
  alreadyPaid: boolean
  credited: boolean
  balance?: number
  expireAt?: Date
}

/**
 * LINE Pay confirm 結果的唯一落帳點。
 * payment row lock、狀態更新、point lot 與 ledger 全在同一個 transaction：
 * - callback 重送／並發只會有一批點數
 * - 任一步失敗就整筆 rollback，不留下「paid 但沒入點」
 */
export async function settlePayment(
  orderId: string,
  providerResult: { ok: boolean; raw: unknown; providerTxn?: string },
): Promise<SettlementResult> {
  return withTransaction(async (client) => {
    const payRes = await client.query<PaymentRow>(
      `SELECT id, tenant_id, amount_twd, points, status
       FROM payments WHERE order_id = $1 FOR UPDATE`,
      [orderId],
    )
    if (!payRes.rowCount) return { found: false, ok: false, alreadyPaid: false, credited: false }

    const payment = payRes.rows[0]
    if (payment.status === 'paid') {
      const balanceRes = await client.query<{ balance: string }>(
        `SELECT COALESCE(SUM(remaining), 0)::text AS balance
         FROM point_lots WHERE tenant_id = $1 AND expire_at > now()`,
        [payment.tenant_id],
      )
      return {
        found: true,
        ok: true,
        alreadyPaid: true,
        credited: false,
        balance: Number(balanceRes.rows[0]?.balance ?? 0),
      }
    }

    if (!providerResult.ok) {
      await client.query(
        `UPDATE payments SET status = 'failed', raw_callback = $2, provider_txn = COALESCE($3, provider_txn)
         WHERE id = $1`,
        [payment.id, JSON.stringify(providerResult.raw), providerResult.providerTxn ?? null],
      )
      return { found: true, ok: false, alreadyPaid: false, credited: false }
    }

    await client.query(
      `UPDATE payments SET status = 'paid', raw_callback = $2,
         provider_txn = COALESCE($3, provider_txn), paid_at = now()
       WHERE id = $1`,
      [payment.id, JSON.stringify(providerResult.raw), providerResult.providerTxn ?? null],
    )

    const granted = await grantPointsInTransaction(client, payment.tenant_id, payment.points, {
      reason: 'purchase',
      source: 'purchase',
      paymentId: payment.id,
      refType: 'payment',
      refId: orderId,
    })
    return {
      found: true,
      ok: true,
      alreadyPaid: !granted.credited,
      credited: granted.credited,
      balance: granted.balance,
      expireAt: granted.expireAt,
    }
  })
}
