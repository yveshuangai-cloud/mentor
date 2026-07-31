/**
 * 租戶隔離的純邏輯（不碰 DB/config，可單獨測試）。
 * 執行端在 tenantDb.ts。
 */

export class TenantScopeError extends Error {
  constructor(sql: string) {
    super(
      `TenantScopeError: SQL 缺少 tenant_id = $1（資料鐵則）。收到的 SQL：${sql.slice(0, 200)}`,
    )
  }
}

const INSERT_RE = /^\s*insert\s+into/i

export function assertTenantScoped(sql: string): void {
  if (INSERT_RE.test(sql)) {
    // INSERT：欄位清單必須含 tenant_id，且 VALUES 對應 $1
    if (!/\btenant_id\b/i.test(sql) || !/\$1\b/.test(sql)) throw new TenantScopeError(sql)
    return
  }
  if (!/tenant_id\s*=\s*\$1\b/i.test(sql)) {
    throw new TenantScopeError(sql)
  }
}

/** 向量記憶的 namespace（fail-closed：查詢端沒有 namespace 就不查，絕不 fallback 全域） */
export function tenantNamespace(tenantId: number): string {
  return `tenant-${tenantId}`
}
