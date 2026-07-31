import type pg from 'pg'
import { pool } from './index.js'
import { assertTenantScoped } from './tenantScope.js'

export { TenantScopeError, assertTenantScoped, tenantNamespace } from './tenantScope.js'

/**
 * 租戶層資料鐵則的執行點：
 * 所有租戶層資料表（conversations、learned_facts、memory_topics、distilled_memories、
 * memory_registry、promises、scheduled_events、diaries、dreams、action_outcomes、
 * reading_plans、reading_notes、point_lots、point_ledger…）的查詢一律經過這裡。
 *
 * 規約（wrapper 會硬檢查，違反直接 throw）：
 *   1. SQL 內必須出現 `tenant_id = $1`（SELECT/UPDATE/DELETE 的 WHERE，或 INSERT 欄位對應）。
 *   2. params 不含 tenantId——wrapper 自動把它插到 $1，其餘參數從 $2 起。
 *
 * 用法：
 *   const db = forTenant(tenantId)
 *   await db.query('SELECT * FROM conversations WHERE tenant_id = $1 AND user_id = $2', [userId])
 *   await db.query('INSERT INTO diaries (tenant_id, diary_date, layer_1) VALUES ($1, $2, $3)', [date, text])
 */

export interface TenantDb {
  readonly tenantId: number
  query<T extends pg.QueryResultRow = pg.QueryResultRow>(
    sql: string,
    params?: unknown[],
  ): Promise<pg.QueryResult<T>>
  /** 交易版：同一連線內多次租戶查詢 */
  withTransaction<T>(fn: (q: TenantDb['query']) => Promise<T>): Promise<T>
}

export function forTenant(tenantId: number): TenantDb {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new Error(`forTenant: invalid tenantId ${tenantId}`)
  }

  const run = async <T extends pg.QueryResultRow>(
    client: { query: pg.Pool['query'] } | pg.PoolClient,
    sql: string,
    params: unknown[] = [],
  ): Promise<pg.QueryResult<T>> => {
    assertTenantScoped(sql)
    return client.query<T>(sql, [tenantId, ...params] as never)
  }

  return {
    tenantId,
    query: (sql, params) => run(pool, sql, params),
    withTransaction: async (fn) => {
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        const result = await fn((sql, params) => run(client, sql, params))
        await client.query('COMMIT')
        return result
      } catch (err) {
        await client.query('ROLLBACK')
        throw err
      } finally {
        client.release()
      }
    },
  }
}
