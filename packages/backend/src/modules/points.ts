import type pg from 'pg'
import { platformQuery, withTransaction } from '../db/index.js'

/**
 * 儲點扣點（交接書 §7）：
 * - point_rules 是「活的」：後台改了即時生效（30s cache + 主動 invalidate）。
 * - 入點成批（point_lots，到期日 = 入點 + expire_days），扣點先扣最快到期的批次。
 * - 每筆增減都寫 point_ledger（balance_after 可對帳）。
 * - 每次互動回覆帶「本次扣點與餘額」（formatPointsFooter）。
 */

export interface PointRule {
  gate: string
  cost: number
  enabled: boolean
}

export class InsufficientPointsError extends Error {
  constructor(
    public readonly balance: number,
    public readonly required: number,
  ) {
    super(`點數不足：餘額 ${balance}、需要 ${required}`)
  }
}

// ── 活的規則表（cache + invalidate）─────────────────────────

let rulesCache: Map<string, PointRule> | null = null
let rulesCacheAt = 0
const RULES_TTL_MS = 30_000

export async function getPointRules(force = false): Promise<Map<string, PointRule>> {
  if (!force && rulesCache && Date.now() - rulesCacheAt < RULES_TTL_MS) return rulesCache
  const res = await platformQuery<{ gate: string; cost: number; enabled: boolean }>(
    'SELECT gate, cost, enabled FROM point_rules',
  )
  rulesCache = new Map(res.rows.map((r) => [r.gate, { gate: r.gate, cost: Number(r.cost), enabled: r.enabled }]))
  rulesCacheAt = Date.now()
  return rulesCache
}

/** 後台改了規則之後呼叫 → 即時生效 */
export function invalidatePointRules(): void {
  rulesCache = null
}

// ── 入點 ─────────────────────────────────────────────

export async function grantPoints(
  tenantId: number,
  points: number,
  opts: { reason: string; source?: string; expireDays?: number; paymentId?: number; refType?: string; refId?: string },
): Promise<{ balance: number; expireAt: Date }> {
  if (points <= 0) throw new Error('grantPoints: points must be > 0')
  return withTransaction((client) => grantPointsInTransaction(client, tenantId, points, opts))
}

/**
 * 與 payment 狀態更新共用同一交易的入點版本。
 * paymentId 有值時以 point_lots 的 partial unique index 保證 callback 重送不會重複入點。
 */
export async function grantPointsInTransaction(
  client: pg.PoolClient,
  tenantId: number,
  points: number,
  opts: { reason: string; source?: string; expireDays?: number; paymentId?: number; refType?: string; refId?: string },
): Promise<{ balance: number; expireAt: Date; credited: boolean }> {
  if (points <= 0) throw new Error('grantPointsInTransaction: points must be > 0')
  const expireDays = opts.expireDays ?? 90
  const paymentId = opts.paymentId ?? null
  const lot = await client.query<{ expire_at: Date }>(
    `INSERT INTO point_lots (tenant_id, granted, remaining, expire_at, source, payment_id)
     VALUES ($1, $2, $2, now() + ($3 || ' days')::interval, $4, $5)
     ON CONFLICT (payment_id) WHERE payment_id IS NOT NULL DO NOTHING
     RETURNING expire_at`,
    [tenantId, points, String(expireDays), opts.source ?? 'purchase', paymentId],
  )

  if (!lot.rowCount && paymentId != null) {
    const existing = await client.query<{ expire_at: Date }>(
      `SELECT expire_at FROM point_lots WHERE payment_id = $1`,
      [paymentId],
    )
    if (!existing.rowCount) throw new Error(`payment lot conflict without row: ${paymentId}`)
    return {
      balance: await balanceInTx(client, tenantId),
      expireAt: existing.rows[0].expire_at,
      credited: false,
    }
  }

  const expireAt = lot.rows[0].expire_at
  const balance = await balanceInTx(client, tenantId)
  await client.query(
    `INSERT INTO point_ledger (tenant_id, delta, reason, balance_after, expire_at, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, points, opts.reason, balance, expireAt, opts.refType ?? null, opts.refId ?? null],
  )
  return { balance, expireAt, credited: true }
}

// ── 扣點（依閘道；FIFO 先扣快到期的）──────────────────────

export interface ChargeResult {
  gate: string
  cost: number
  balance: number
  charged: boolean // false = 閘道停用或 cost=0
}

export async function chargeGate(
  tenantId: number,
  gate: string,
  opts: { refType?: string; refId?: string } = {},
): Promise<ChargeResult> {
  const rules = await getPointRules()
  const rule = rules.get(gate)
  if (!rule || !rule.enabled || rule.cost === 0) {
    const balance = await getBalance(tenantId)
    return { gate, cost: 0, balance, charged: false }
  }
  return withTransaction(async (client) => {
    // 鎖住這一戶未過期、還有餘量的批次，最快到期的先扣
    const lots = await client.query<{ id: number; remaining: number }>(
      `SELECT id, remaining FROM point_lots
       WHERE tenant_id = $1 AND remaining > 0 AND expire_at > now()
       ORDER BY expire_at ASC
       FOR UPDATE`,
      [tenantId],
    )
    const available = lots.rows.reduce((sum, l) => sum + Number(l.remaining), 0)
    if (available < rule.cost) throw new InsufficientPointsError(available, rule.cost)

    let toConsume = rule.cost
    for (const lot of lots.rows) {
      if (toConsume <= 0) break
      const take = Math.min(Number(lot.remaining), toConsume)
      await client.query(`UPDATE point_lots SET remaining = remaining - $2 WHERE id = $1`, [lot.id, take])
      toConsume -= take
    }
    const balance = available - rule.cost
    await client.query(
      `INSERT INTO point_ledger (tenant_id, delta, gate, reason, balance_after, ref_type, ref_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, -rule.cost, gate, `charge:${gate}`, balance, opts.refType ?? null, opts.refId ?? null],
    )
    return { gate, cost: rule.cost, balance, charged: true }
  })
}

// ── 餘額與到期 ────────────────────────────────────────

async function balanceInTx(
  client: { query: (sql: string, params: unknown[]) => Promise<{ rows: { sum: string | null }[] }> },
  tenantId: number,
): Promise<number> {
  const res = await client.query(
    `SELECT COALESCE(SUM(remaining), 0)::text AS sum FROM point_lots
     WHERE tenant_id = $1 AND expire_at > now()`,
    [tenantId],
  )
  return Number(res.rows[0]?.sum ?? 0)
}

export async function getBalance(tenantId: number): Promise<number> {
  const res = await platformQuery<{ sum: string | null }>(
    `SELECT COALESCE(SUM(remaining), 0)::text AS sum FROM point_lots
     WHERE tenant_id = $1 AND expire_at > now()`,
    [tenantId],
  )
  return Number(res.rows[0]?.sum ?? 0)
}

export async function getNearestExpiry(
  tenantId: number,
): Promise<{ points: number; expireAt: Date } | null> {
  const res = await platformQuery<{ remaining: number; expire_at: Date }>(
    `SELECT remaining, expire_at FROM point_lots
     WHERE tenant_id = $1 AND remaining > 0 AND expire_at > now()
     ORDER BY expire_at ASC LIMIT 1`,
    [tenantId],
  )
  if (!res.rowCount) return null
  return { points: Number(res.rows[0].remaining), expireAt: res.rows[0].expire_at }
}

/** 到期歸零（每日 cron）：把過期批次清零並記帳 */
export async function expireSweep(log: (msg: string) => void): Promise<void> {
  await withTransaction(async (client) => {
    // 先鎖定並讀出「歸零前」餘額；UPDATE ... RETURNING remaining 只會拿到更新後的 0。
    const expired = await client.query<{ id: number; tenant_id: number; total: number }>(
      `SELECT id, tenant_id, remaining AS total FROM point_lots
       WHERE remaining > 0 AND expire_at <= now()
       FOR UPDATE`,
    )
    if (expired.rowCount) {
      await client.query(
        `UPDATE point_lots SET remaining = 0 WHERE id = ANY($1::bigint[])`,
        [expired.rows.map((row) => row.id)],
      )
    }
    const byTenant = new Map<number, number>()
    for (const row of expired.rows) {
      byTenant.set(row.tenant_id, (byTenant.get(row.tenant_id) ?? 0) + Number(row.total))
    }
    for (const [tenantId, total] of byTenant) {
      const res = await client.query<{ sum: string | null }>(
        `SELECT COALESCE(SUM(remaining), 0)::text AS sum FROM point_lots
         WHERE tenant_id = $1 AND expire_at > now()`,
        [tenantId],
      )
      const balance = Number(res.rows[0]?.sum ?? 0)
      await client.query(
        `INSERT INTO point_ledger (tenant_id, delta, reason, balance_after, ref_type)
         VALUES ($1, $2, 'expire', $3, 'cron')`,
        [tenantId, -total, balance],
      )
      log(`points expired: tenant=${tenantId} -${total} → ${balance}`)
    }
  })
}

// ── 呈現 ─────────────────────────────────────────────

/** 互動回覆尾註：「⚡ 本次 -1 點｜餘額 987 點」 */
export function formatPointsFooter(charge: ChargeResult): string {
  if (!charge.charged) return ''
  return `⚡ 本次 -${charge.cost} 點｜餘額 ${charge.balance} 點`
}

/** 「點數」查詢：只使用平台正式名稱，不帶舊人格文案。 */
export async function buildPointsReport(tenantId: number): Promise<string> {
  const [balance, nearest, recent] = await Promise.all([
    getBalance(tenantId),
    getNearestExpiry(tenantId),
    platformQuery<{ gate: string | null; spent: string }>(
      `SELECT gate, ABS(SUM(delta))::text AS spent FROM point_ledger
       WHERE tenant_id = $1 AND delta < 0 AND reason LIKE 'charge:%'
         AND created_at > now() - interval '30 days'
       GROUP BY gate ORDER BY ABS(SUM(delta)) DESC`,
      [tenantId],
    ),
  ])
  const gateNames: Record<string, string> = {
    text: '陪你說話（動腦）',
    voice: '用聲音說話',
    image: '畫圖／做卡片',
    web_search: '出門查資料',
    proactive: '主動來找你',
  }
  const lines = recent.rows.map(
    (r) => `・${gateNames[r.gate ?? ''] ?? r.gate}：${r.spent} 點`,
  )
  const expireLine = nearest
    ? `最快到期的一批：${nearest.points} 點（${nearest.expireAt.toISOString().slice(0, 10)} 到期）`
    : ''
  return [
    `目前點數餘額：${balance} 點`,
    lines.length ? `最近 30 天花在：\n${lines.join('\n')}` : '最近 30 天還沒花到點點',
    expireLine,
  ]
    .filter(Boolean)
    .join('\n\n')
}
