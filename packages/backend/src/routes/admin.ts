import type { FastifyInstance } from 'fastify'
import { platformQuery } from '../db/index.js'
import { invalidatePointRules, getPointRules } from '../modules/points.js'

/**
 * 後台（v1：扣點規則活調、帳本、租戶與成員總覽）。
 * ⚠️ v1 以 ADMIN_TOKEN header 簡易保護；正式上線換 JWT + admins 表登入。
 */

function requireAdmin(app: FastifyInstance): void {
  app.addHook('preHandler', async (req, reply) => {
    const token = req.headers['x-admin-token']
    const expected = process.env.ADMIN_TOKEN
    if (!expected || token !== expected) {
      await reply.code(401).send({ error: 'unauthorized' })
    }
  })
}

export async function adminRoutes(app: FastifyInstance): Promise<void> {
  requireAdmin(app)

  // ── 活的扣點規則：看 + 調（即時生效）─────────────
  app.get('/point-rules', async () => {
    const rules = await getPointRules(true)
    return { rules: [...rules.values()] }
  })

  app.put<{ Params: { gate: string }; Body: { cost?: number; enabled?: boolean; description?: string } }>(
    '/point-rules/:gate',
    async (req, reply) => {
      const { gate } = req.params
      const { cost, enabled, description } = req.body ?? {}
      const res = await platformQuery(
        `INSERT INTO point_rules (gate, cost, enabled, description, updated_by)
         VALUES ($1, COALESCE($2, 1), COALESCE($3, TRUE), $4, 'admin')
         ON CONFLICT (gate) DO UPDATE SET
           cost = COALESCE($2, point_rules.cost),
           enabled = COALESCE($3, point_rules.enabled),
           description = COALESCE($4, point_rules.description),
           updated_by = 'admin', updated_at = now()
         RETURNING *`,
        [gate, cost ?? null, enabled ?? null, description ?? null],
      )
      invalidatePointRules() // 活的：改了馬上生效
      return reply.send({ rule: res.rows[0] })
    },
  )

  // ── 帳本 ─────────────────────────────────
  app.get<{ Params: { tenantId: string } }>('/tenants/:tenantId/ledger', async (req) => {
    const tenantId = Number(req.params.tenantId)
    const res = await platformQuery(
      `SELECT id, delta, gate, reason, balance_after, expire_at, ref_type, ref_id, created_at
       FROM point_ledger WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 200`,
      [tenantId],
    )
    return { ledger: res.rows }
  })

  // ── 租戶與成員總覽 ─────────────────────────
  app.get('/tenants', async () => {
    const res = await platformQuery(
      `SELECT t.id, t.mode, t.status, t.genesis_at, t.created_at,
              u.display_name AS owner_name,
              (SELECT COUNT(*) FROM tenant_members m WHERE m.tenant_id = t.id AND m.status = 'confirmed') AS members,
              (SELECT COALESCE(SUM(remaining), 0) FROM point_lots l WHERE l.tenant_id = t.id AND l.expire_at > now()) AS balance
       FROM tenants t LEFT JOIN users u ON u.id = t.owner_user_id
       ORDER BY t.created_at DESC LIMIT 100`,
    )
    return { tenants: res.rows }
  })

  app.get<{ Params: { tenantId: string } }>('/tenants/:tenantId/members', async (req) => {
    const tenantId = Number(req.params.tenantId)
    const res = await platformQuery(
      `SELECT m.id, u.display_name, m.role, m.relationship, m.status, m.confirmed_at, m.created_at
       FROM tenant_members m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 ORDER BY m.created_at`,
      [tenantId],
    )
    return { members: res.rows }
  })
}
