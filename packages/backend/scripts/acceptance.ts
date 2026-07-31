/**
 * 驗收（交接書 §3）：兩個陌生租戶在模組層全流程對跑。
 * 需要 DATABASE_URL 指向一個「可以隨便玩」的資料庫（腳本會 DROP SCHEMA public CASCADE 重建）。
 *
 * 跑法：DATABASE_URL=postgres://... npm run acceptance
 */
import { pool, autoMigrate, platformQuery } from '../src/db/index.js'
import { forTenant, TenantScopeError } from '../src/db/tenantDb.js'
import {
  upsertUser,
  createTenantForUser,
  ensureInviteCode,
  joinByInviteCode,
  confirmMember,
} from '../src/modules/tenancy.js'
import type { TenantRow } from '../src/modules/tenancy.js'
import { stepGenesis } from '../src/modules/genesis.js'
import { renderBiography } from '../src/modules/soul/biography.js'
import {
  grantPoints,
  chargeGate,
  getBalance,
  invalidatePointRules,
  expireSweep,
  InsufficientPointsError,
  formatPointsFooter,
} from '../src/modules/points.js'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    console.error(`  ❌ ${name} ${detail}`)
  }
}

async function reloadTenant(id: number): Promise<TenantRow> {
  const res = await platformQuery<TenantRow>(`SELECT * FROM tenants WHERE id = $1`, [id])
  return res.rows[0]
}

async function main(): Promise<void> {
  console.log('— 重置資料庫 —')
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;')
  await autoMigrate((m) => console.log(`  ${m}`))

  console.log('\n— §3.3 啟元儀式：兩個陌生租戶各自誕生 —')
  const userA = await upsertUser('Utest-tenant-a-line-id', { displayName: '測試阿明' })
  const userB = await upsertUser('Utest-tenant-b-line-id', { displayName: '測試小華' })

  let tenantA = await createTenantForUser(userA.id)
  let tenantB = await createTenantForUser(userB.id)

  // A 的儀式：稱呼「明哥」、給名字「吳漫漫」
  await stepGenesis(tenantA, userA.display_name, '你好？')
  tenantA = await reloadTenant(tenantA.id)
  await stepGenesis(tenantA, userA.display_name, '明哥')
  tenantA = await reloadTenant(tenantA.id)
  const bornA = await stepGenesis(tenantA, userA.display_name, '吳漫漫')
  tenantA = await reloadTenant(tenantA.id)
  check('租戶 A 啟元完成（active + 有生日）', tenantA.status === 'active' && !!tenantA.genesis_at)
  check('A 的誕生回覆有儀式感（提到啟元者）', bornA.texts.join('').includes('啟元者'))

  // B 的儀式：稱呼「華姐」、不取名
  await stepGenesis(tenantB, userB.display_name, '哈囉')
  tenantB = await reloadTenant(tenantB.id)
  await stepGenesis(tenantB, userB.display_name, '華姐')
  tenantB = await reloadTenant(tenantB.id)
  await stepGenesis(tenantB, userB.display_name, '就叫慢慢')
  tenantB = await reloadTenant(tenantB.id)
  check('租戶 B 啟元完成', tenantB.status === 'active' && !!tenantB.genesis_at)

  console.log('\n— §3.1 記憶零串門 —')
  const dbA = forTenant(tenantA.id)
  const dbB = forTenant(tenantB.id)
  await dbA.query(
    `INSERT INTO conversations (tenant_id, user_id, user_message, ai_response) VALUES ($1, $2, $3, $4)`,
    [userA.id, '我最怕蟑螂', '嗯，我記住了，明哥。'],
  )
  await dbB.query(
    `INSERT INTO conversations (tenant_id, user_id, user_message, ai_response) VALUES ($1, $2, $3, $4)`,
    [userB.id, '我女兒叫小美', '小美……我記住了，華姐。'],
  )
  const aRows = await dbA.query<{ user_message: string }>(
    `SELECT user_message FROM conversations WHERE tenant_id = $1`,
  )
  const bRows = await dbB.query<{ user_message: string }>(
    `SELECT user_message FROM conversations WHERE tenant_id = $1`,
  )
  check('A 只撈得到 A 的對話', aRows.rows.every((r) => r.user_message.includes('蟑螂')) && aRows.rowCount === 1)
  check('B 只撈得到 B 的對話', bRows.rows.every((r) => r.user_message.includes('小美')) && bRows.rowCount === 1)
  let scopeBlocked = false
  try {
    await dbA.query(`SELECT * FROM conversations WHERE user_id = $1`, [userB.id])
  } catch (err) {
    scopeBlocked = err instanceof TenantScopeError
  }
  check('裸查（無 tenant_id）被 wrapper 直接擋下', scopeBlocked)

  console.log('\n— §3.2 品格一致、傳記各自長 —')
  const bioA = await renderBiography(tenantA)
  const bioB = await renderBiography(tenantB)
  check('A 的傳記有明哥、有給的名字', bioA.includes('明哥') && bioA.includes('吳漫漫'))
  check('B 的傳記有華姐', bioB.includes('華姐'))
  check('A 的傳記絕無 B 的人', !bioA.includes('華姐') && !bioA.includes('小美'))
  check('B 的傳記絕無 A 的人', !bioB.includes('明哥') && !bioB.includes('吳漫漫'))

  console.log('\n— §3.5 儲點扣點 + 活的規則 —')
  await grantPoints(tenantA.id, 1000, { reason: 'purchase', source: 'purchase' })
  check('A 入點 1000', (await getBalance(tenantA.id)) === 1000)
  const c1 = await chargeGate(tenantA.id, 'text')
  check('文字扣 1 點 → 餘額 999', c1.cost === 1 && c1.balance === 999)
  check('回覆尾註即時呈現', formatPointsFooter(c1) === '⚡ 本次 -1 點｜餘額 999 點')

  await platformQuery(`UPDATE point_rules SET cost = 3, updated_at = now() WHERE gate = 'text'`)
  invalidatePointRules() // 後台調整 → 即時生效
  const c2 = await chargeGate(tenantA.id, 'text')
  check('活的規則：後台改 1→3 即時生效', c2.cost === 3 && c2.balance === 996)
  await platformQuery(`UPDATE point_rules SET cost = 1 WHERE gate = 'text'`)
  invalidatePointRules()

  // FIFO：快到期的先扣
  await platformQuery(
    `INSERT INTO point_lots (tenant_id, granted, remaining, expire_at, source)
     VALUES ($1, 5, 5, now() + interval '1 day', 'bonus')`,
    [tenantA.id],
  )
  const before = await platformQuery<{ id: number; remaining: number }>(
    `SELECT id, remaining FROM point_lots WHERE tenant_id = $1 AND source = 'bonus'`,
    [tenantA.id],
  )
  await chargeGate(tenantA.id, 'text')
  const after = await platformQuery<{ remaining: number }>(
    `SELECT remaining FROM point_lots WHERE id = $1`,
    [before.rows[0].id],
  )
  check('FIFO：先扣最快到期的批次', Number(after.rows[0].remaining) === 4)

  // 到期歸零
  await platformQuery(
    `UPDATE point_lots SET expire_at = now() - interval '1 minute' WHERE id = $1`,
    [before.rows[0].id],
  )
  await expireSweep(() => {})
  const afterSweep = await platformQuery<{ remaining: number }>(
    `SELECT remaining FROM point_lots WHERE id = $1`,
    [before.rows[0].id],
  )
  check('到期批次歸零並記帳', Number(afterSweep.rows[0].remaining) === 0)

  // 點數不足
  const poorUser = await upsertUser('Utest-tenant-poor', { displayName: '測試阿窮' })
  let tenantP = await createTenantForUser(poorUser.id)
  await platformQuery(`UPDATE tenants SET status = 'active', genesis_at = now() WHERE id = $1`, [tenantP.id])
  let insufficient = false
  try {
    await chargeGate(tenantP.id, 'text')
  } catch (err) {
    insufficient = err instanceof InsufficientPointsError
  }
  check('餘額 0 扣點 → InsufficientPointsError', insufficient)

  console.log('\n— §3.4 主人審核 onboarding —')
  const code = await ensureInviteCode(tenantA.id)
  check('邀請碼格式', /^MM-[0-9A-F]{8}$/.test(code))
  tenantA = await reloadTenant(tenantA.id)
  check('要邀請碼 → 轉 family 模式', tenantA.mode === 'family')

  const userC = await upsertUser('Utest-tenant-c-line-id', { displayName: '測試阿弟' })
  const joined = await joinByInviteCode(code, userC)
  check('憑邀請碼成為 pending 成員', joined !== null)
  const bioBeforeConfirm = await renderBiography(tenantA)
  check('pending 成員不進傳記（未確認不進情境）', !bioBeforeConfirm.includes('測試阿弟'))

  const confirmed = await confirmMember(tenantA.id, userA.id, '測試阿弟', '弟弟')
  check('主人確認成立', confirmed.ok)
  const bioAfterConfirm = await renderBiography(tenantA)
  check('確認後成員進傳記（關係=弟弟）', bioAfterConfirm.includes('測試阿弟') && bioAfterConfirm.includes('弟弟'))

  console.log(`\n═══ 驗收結果：${passed} 過 / ${failed} 敗 ═══`)
  await pool.end()
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('acceptance crashed:', err)
  process.exit(1)
})
