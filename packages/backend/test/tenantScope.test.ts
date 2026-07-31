import { describe, it, expect } from 'vitest'
import { assertTenantScoped, TenantScopeError, tenantNamespace } from '../src/db/tenantScope.js'

/** 資料鐵則的守門測試：沒帶 tenant_id 的 SQL 必須被擋下（§12 跨租戶零串門） */
describe('assertTenantScoped', () => {
  it('放行帶 tenant_id = $1 的 SELECT', () => {
    expect(() =>
      assertTenantScoped('SELECT * FROM conversations WHERE tenant_id = $1 AND user_id = $2'),
    ).not.toThrow()
  })

  it('擋下沒有 tenant_id 的 SELECT（裸查）', () => {
    expect(() => assertTenantScoped('SELECT * FROM conversations WHERE user_id = $1')).toThrow(
      TenantScopeError,
    )
  })

  it('擋下 tenant_id 不在 $1 的 SELECT（參數位錯置）', () => {
    expect(() =>
      assertTenantScoped('SELECT * FROM conversations WHERE user_id = $1 AND tenant_id = $2'),
    ).toThrow(TenantScopeError)
  })

  it('放行欄位含 tenant_id 且對應 $1 的 INSERT', () => {
    expect(() =>
      assertTenantScoped(
        'INSERT INTO diaries (tenant_id, diary_date, layer_1) VALUES ($1, $2, $3)',
      ),
    ).not.toThrow()
  })

  it('擋下沒有 tenant_id 欄位的 INSERT', () => {
    expect(() =>
      assertTenantScoped('INSERT INTO diaries (diary_date, layer_1) VALUES ($1, $2)'),
    ).toThrow(TenantScopeError)
  })

  it('擋下 UPDATE 無 tenant_id 條件', () => {
    expect(() => assertTenantScoped('UPDATE promises SET status = $1 WHERE id = $2')).toThrow(
      TenantScopeError,
    )
  })

  it('放行 UPDATE 帶 tenant_id = $1', () => {
    expect(() =>
      assertTenantScoped('UPDATE promises SET status = $2 WHERE tenant_id = $1 AND id = $3'),
    ).not.toThrow()
  })
})

describe('tenantNamespace', () => {
  it('每租戶一個 vector namespace（fail-closed 隔離）', () => {
    expect(tenantNamespace(7)).toBe('tenant-7')
    expect(tenantNamespace(8)).not.toBe(tenantNamespace(7))
  })
})
