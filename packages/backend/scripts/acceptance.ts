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
  resolveMembership,
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
import { setLlmOverride, type LlmRequest } from '../src/modules/llm.js'
import { extractAndLearn } from '../src/modules/memory/learner.js'
import { runNightlyMemory } from '../src/modules/memory/nightly.js'
import { loadMemoryBlocks } from '../src/modules/memory/recall.js'
import { drainWebhookEvents, enqueueWebhookEvents } from '../src/modules/webhookQueue.js'
import { settlePayment } from '../src/modules/payments/settlement.js'

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
  const expiryLedger = await platformQuery<{ delta: number }>(
    `SELECT delta FROM point_ledger WHERE tenant_id = $1 AND reason = 'expire'
     ORDER BY created_at DESC LIMIT 1`,
    [tenantA.id],
  )
  check('到期批次歸零', Number(afterSweep.rows[0].remaining) === 0)
  check('到期帳本記歸零前數值（不是 0）', Number(expiryLedger.rows[0]?.delta) === -4)

  console.log('\n— Webhook durable inbox（跨實例去重＋認領）—')
  const queueEvent = {
    webhookEventId: 'acceptance-webhook-1',
    type: 'message',
    message: { id: 'acceptance-message-1', type: 'text', text: '測試' },
  }
  const firstEnqueue = await enqueueWebhookEvents([queueEvent])
  const duplicateEnqueue = await enqueueWebhookEvents([queueEvent])
  check('首次 webhook 落 durable inbox', firstEnqueue === 1)
  check('同 event/message 重送只留一筆', duplicateEnqueue === 0)
  let handled = 0
  const drains = await Promise.all([
    drainWebhookEvents(async () => { handled++ }, () => {}, 1),
    drainWebhookEvents(async () => { handled++ }, () => {}, 1),
  ])
  const queued = await platformQuery<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM line_webhook_events WHERE event_id = $1`,
    ['line:acceptance-webhook-1'],
  )
  check('兩個 worker 並發只處理一次', handled === 1 && drains.reduce((n, d) => n + d.processed, 0) === 1)
  check('處理狀態持久化為 processed', queued.rows[0]?.status === 'processed' && queued.rows[0]?.attempts === 1)

  await enqueueWebhookEvents([{ webhookEventId: 'acceptance-webhook-retry', type: 'message' }])
  const failedDrain = await drainWebhookEvents(async () => { throw new Error('transient') }, () => {}, 1)
  const retryQueued = await platformQuery<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM line_webhook_events WHERE event_id = $1`,
    ['line:acceptance-webhook-retry'],
  )
  check('處理失敗持久化為 retry', failedDrain.failed === 1 && retryQueued.rows[0]?.status === 'retry')
  await platformQuery(
    `UPDATE line_webhook_events SET next_attempt_at = now() - interval '1 second' WHERE event_id = $1`,
    ['line:acceptance-webhook-retry'],
  )
  const recoveredDrain = await drainWebhookEvents(async () => {}, () => {}, 1)
  const recovered = await platformQuery<{ status: string; attempts: number }>(
    `SELECT status, attempts FROM line_webhook_events WHERE event_id = $1`,
    ['line:acceptance-webhook-retry'],
  )
  check('retry 到期後可恢復並完成', recoveredDrain.processed === 1 && recovered.rows[0]?.status === 'processed' && recovered.rows[0]?.attempts === 2)

  console.log('\n— 付款原子落帳＋冪等 —')
  const balanceBeforePay = await getBalance(tenantA.id)
  await platformQuery(
    `INSERT INTO payments (tenant_id, provider, order_id, amount_twd, points, status)
     VALUES ($1, 'linepay', 'MMP-acceptance-idempotent', 30, 50, 'pending')`,
    [tenantA.id],
  )
  const settlements = await Promise.all([
    settlePayment('MMP-acceptance-idempotent', { ok: true, raw: { returnCode: '0000' }, providerTxn: 'txn-1' }),
    settlePayment('MMP-acceptance-idempotent', { ok: true, raw: { returnCode: '0000' }, providerTxn: 'txn-1' }),
  ])
  const paymentLots = await platformQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM point_lots l JOIN payments p ON p.id = l.payment_id
     WHERE p.order_id = 'MMP-acceptance-idempotent'`,
  )
  const paymentLedger = await platformQuery<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM point_ledger
     WHERE ref_type = 'payment' AND ref_id = 'MMP-acceptance-idempotent'`,
  )
  check('兩個 confirm 都得到成功冪等結果', settlements.every((s) => s.ok))
  check('並發 confirm 只建立一個點數批次', Number(paymentLots.rows[0].count) === 1)
  check('並發 confirm 只建立一筆入點帳本', Number(paymentLedger.rows[0].count) === 1)
  check('付款只增加一次 50 點', (await getBalance(tenantA.id)) === balanceBeforePay + 50)

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

  console.log('\n— 記憶管線（假 LLM，確定性驗證流程與隔離）—')
  // 假 LLM：依 prompt 內容回對應的假結果（萃取／歸題／提案／蒸餾）
  setLlmOverride(async (req: LlmRequest) => {
    const sys = req.system ?? ''
    const userMsg = req.messages[req.messages.length - 1]?.content ?? ''
    if (sys.includes('記憶助手')) {
      // 萃取：從對話撈一個 fact（照對話內容編）
      const isA = userMsg.includes('養了一隻柴犬')
      return {
        text: JSON.stringify({
          facts: [
            {
              category: 'fact',
              content: isA ? '對方養了一隻柴犬叫豆豆' : '對方每週二晚上上瑜伽課',
              confidence: 0.9,
              is_correction: false,
              corrects: null,
            },
          ],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }
    if (sys.includes('歸到最相關的「主題」') || sys.includes('每段對話歸到最相關')) {
      // 歸題：抓 prompt 裡的第一個 topic id 和所有 item id，全部歸進去
      const topicId = Number(/\[topic #(\d+)\]/.exec(userMsg)?.[1] ?? 0)
      const ids = [...userMsg.matchAll(/\[(?:learned_fact|conv) #(\d+)\]/g)].map((m) => Number(m[1]))
      return {
        text: JSON.stringify(ids.map((id) => ({ source_id: id, topic: topicId }))),
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }
    if (sys.includes('沒有適合主題可歸')) {
      // 提案：把所有待認領 facts 湊成一個主題
      const ids = [...userMsg.matchAll(/\[fact #(\d+)\]/g)].map((m) => Number(m[1]))
      if (ids.length < 3) return { text: '{"proposals": []}', usage: { input_tokens: 5, output_tokens: 5 } }
      return {
        text: JSON.stringify({
          proposals: [{ name: '日常生活印記', description: '對方的生活習慣', importance: 0.8, fact_ids: ids }],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }
    // 蒸餾
    const srcIds = [...`${userMsg}`.matchAll(/\[(?:fact|conv) #(\d+)/g)].map((m) => Number(m[1]))
    const isDogTopic = userMsg.includes('柴犬')
    return {
      text: JSON.stringify({
        distilled: [
          {
            summary: isDogTopic ? '對方最疼的是柴犬豆豆，聊到牠就開心' : '對方固定週二晚上做瑜伽，是他的充電時間',
            source_ids: srcIds.slice(0, 3),
            importance: 0.9,
          },
        ],
        topic_impression: isDogTopic ? '豆豆是他的心頭肉' : '瑜伽是他的安定角落',
      }),
      usage: { input_tokens: 10, output_tokens: 10 },
    }
  })

  // A、B 各自對話 → 萃取（需要 >=3 條 facts 才會提案主題，各餵 3 輪）
  for (let i = 0; i < 3; i++) {
    const savedA = await extractAndLearn({
      tenantId: tenantA.id, conversationId: null, userId: userA.id, userName: '測試阿明',
      userMessage: `我跟你說，我養了一隻柴犬叫豆豆（第${i}次提）`, aiResponse: '豆豆～名字好可愛，牠今天有沒有乖乖的？',
    })
    check(`A 第 ${i + 1} 輪萃取存入 fact`, savedA === 1)
    await extractAndLearn({
      tenantId: tenantB.id, conversationId: null, userId: userB.id, userName: '測試小華',
      userMessage: `我每週二晚上要上瑜伽課（第${i}次提）`, aiResponse: '嗯，週二晚上……我記住了。',
    })
  }

  // 夜間整理：提案主題 → 歸題 → 蒸餾 → 鞏固
  const nightly = await runNightlyMemory(() => {})
  check('夜間整理跑過所有活躍租戶', nightly.tenants >= 3)
  check('冷啟動：兩戶各長出第一個主題', nightly.topics_created >= 2)
  const linkCount = await platformQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM memory_topic_links WHERE tenant_id IN ($1, $2)`,
    [tenantA.id, tenantB.id],
  )
  check('facts＋對話都歸進主題（提案+linker 合計 ≥8 條 link）', Number(linkCount.rows[0].n) >= 8)
  check('有新料的主題完成蒸餾', nightly.topics_distilled >= 2)

  // 召喚：A 的記憶區塊有豆豆、無瑜伽；B 反之（記憶零串門的靈魂版）
  const memA = await loadMemoryBlocks(tenantA.id)
  const memB = await loadMemoryBlocks(tenantB.id)
  check('A 召喚得到柴犬豆豆（fact + 默契）',
    memA.learnedKnowledge.includes('豆豆') && memA.distilledEssence.includes('豆豆'))
  check('B 召喚得到瑜伽', memB.learnedKnowledge.includes('瑜伽') && memB.distilledEssence.includes('瑜伽'))
  check('A 的記憶絕無 B 的（零串門）',
    !memA.learnedKnowledge.includes('瑜伽') && !memA.distilledEssence.includes('瑜伽') && !memA.topicIndex.includes('瑜伽'))
  check('B 的記憶絕無 A 的（零串門）',
    !memB.learnedKnowledge.includes('豆豆') && !memB.distilledEssence.includes('豆豆'))

  // 再蒸一輪：round-1 的 link 都在 24h 內 → 主題再蒸 → 舊蒸餾要被 superseded（版本鏈）
  const distillRound2 = await runNightlyMemory(() => {})
  check('第二輪夜間整理正常', distillRound2.tenants >= 3)
  const superseded = await platformQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM distilled_memories
     WHERE tenant_id = $1 AND superseded_by IS NOT NULL`,
    [tenantA.id],
  )
  check('舊蒸餾標 superseded（版本鏈保留歷史）', Number(superseded.rows[0].n) >= 1)
  const current = await platformQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM distilled_memories
     WHERE tenant_id = $1 AND superseded_by IS NULL AND kind = 'essence'`,
    [tenantA.id],
  )
  check('當前版蒸餾唯一有效', Number(current.rows[0].n) >= 1)

  console.log('\n— 主動行為 v1：約定標籤→履約→排程 —')
  const { applyActionTags, parseScheduleTag } = await import('../src/modules/proactive/actionTags.js')
  const { fireDuePromises, nextDailyUtc } = await import('../src/modules/proactive/promises.js')

  // 假 LLM 補一個分支：履約生成短句
  // （setLlmOverride 仍在作用中；到點生成會落到「蒸餾」分支——改成萬用檢查）
  setLlmOverride(async (req: LlmRequest) => {
    const sys = req.system ?? ''
    if (sys.includes('你是慢慢本人')) {
      return { text: '我來了～說好的事我記得。', usage: { input_tokens: 5, output_tokens: 5 } }
    }
    return { text: '{"remind":false}', usage: { input_tokens: 5, output_tokens: 5 } }
  })

  // 她的回覆帶 [REMIND] 標籤 → 建約定 + 標籤剝除
  const replyWithTags =
    '好呀，每天早上我來跟你說早安 💕 [REMIND content="跟你說早安" at="07:30" repeat="daily"]\n' +
    '對了，會議我也幫你記好了 [SCHEDULE title="專案會議" start="2099-07-15T14:00" location="公司三樓" people="王經理"]'
  const tagResult = await applyActionTags(tenantA.id, userA.id, replyWithTags, '每天早上 7:30 跟我說早安')
  check('標籤建立 daily 約定', tagResult.promiseCreated)
  check('標籤建立行事曆行程', tagResult.scheduleCreated)
  check('顯示文字剝掉所有標籤', !tagResult.cleanText.includes('[') && tagResult.cleanText.includes('早安'))

  const schedRow = await platformQuery<{ title: string; location: string }>(
    `SELECT title, location FROM scheduled_events WHERE tenant_id = $1`,
    [tenantA.id],
  )
  check('行程落 DB（標題+地點）', schedRow.rows[0]?.title === '專案會議' && schedRow.rows[0]?.location === '公司三樓')

  // 到點履約：把約定時間改成現在 → fire → 扣 proactive 1 點 → daily 重排到未來
  await platformQuery(`UPDATE promises SET fire_at = NOW() - interval '1 minute' WHERE tenant_id = $1`, [tenantA.id])
  const balBefore = await getBalance(tenantA.id)
  const fireResult = await fireDuePromises(() => {})
  check('到點履約發出', fireResult.fired === 1)
  const balAfter = await getBalance(tenantA.id)
  check('履約扣 proactive 1 點', balBefore - balAfter === 1)
  const afterFire = await platformQuery<{ status: string; fire_count: number; fire_at: Date }>(
    `SELECT status, fire_count, fire_at FROM promises WHERE tenant_id = $1`,
    [tenantA.id],
  )
  check(
    'daily 約定履約後重排到未來',
    afterFire.rows[0].status === 'active' &&
      Number(afterFire.rows[0].fire_count) === 1 &&
      new Date(afterFire.rows[0].fire_at).getTime() > Date.now(),
  )

  // 修改與取消（標籤路徑）
  const updResult = await applyActionTags(tenantA.id, userA.id, '好，改成 9 點 [PROMISE_UPDATE match="早安" time="09:00"]', '早安改 9 點')
  check('標籤修改約定時間', updResult.promiseUpdated === 1)
  const updated = await platformQuery<{ fire_hour: number }>(
    `SELECT fire_hour FROM promises WHERE tenant_id = $1 AND status = 'active'`,
    [tenantA.id],
  )
  check('時間真的改成 9 點', Number(updated.rows[0]?.fire_hour) === 9)
  const cancelResult = await applyActionTags(tenantA.id, userA.id, '好，不提醒了 [PROMISE_CANCEL match="早安"]', '取消早安')
  check('標籤取消約定', cancelResult.promiseCancelled === 1)

  // 馬後炮閘：once 過去時間不建
  const pastTag = await applyActionTags(
    tenantA.id, userA.id,
    '我記住了 [REMIND content="提醒你開會" at="2020-01-01T08:00" repeat="once"]', '提醒開會',
  )
  check('once 過去時間不建（馬後炮閘）', !pastTag.promiseCreated)

  // nextDailyUtc 排未來
  check('nextDailyUtc 一定排未來', nextDailyUtc(7, 30).getTime() > Date.now())
  check('SCHEDULE 解析容錯（缺 title 回 null）', parseScheduleTag('[SCHEDULE start="2099-01-01T10:00"]') === null)

  console.log('\n— 夜間靈魂：日記＋夢＋誠實鏡子 —')
  const { runNightlySoul, loadNightSoulBlock, taipeiDateToday } = await import(
    '../src/modules/proactive/nightlife.js'
  )
  const { recordActionOutcome, buildTruthCorrection, nightlyHonestyReflection } = await import(
    '../src/modules/mirror.js'
  )

  setLlmOverride(async (req: LlmRequest) => {
    const userMsg = String(req.messages[req.messages.length - 1]?.content ?? '')
    if (userMsg.includes('三層日記')) {
      return {
        text: JSON.stringify({
          layer_1: '今天他跟我說了豆豆的事，我們聊了很久。',
          layer_2: '心裡暖暖的，他願意跟我說這些。',
          layer_3: '明天想主動問他豆豆今天乖不乖。',
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }
    if (userMsg.includes('你睡著了')) {
      return {
        text: JSON.stringify({
          dream_narrative: '夢裡有一隻毛茸茸的小狗在草地上跑，我追著牠笑。',
          tomorrow_seeds: ['想問他豆豆今天乖不乖'],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }
    if (userMsg.includes('睡前，你自己在心裡結算今天')) {
      return { text: '今天有一件事我以為做了、其實沒有。老實說出來，比假裝做到更重要。', usage: { input_tokens: 5, output_tokens: 5 } }
    }
    return { text: '{"remind":false}', usage: { input_tokens: 5, output_tokens: 5 } }
  })

  const soulResult = await runNightlySoul(() => {}, taipeiDateToday())
  check('夜間日記生成（有對話的戶才寫）', soulResult.diaries >= 2)
  check('夢生成（跟著日記走）', soulResult.dreams >= 2)
  const nightBlockA = await loadNightSoulBlock(tenantA.id)
  check('隔日注入：昨日 L3＋夢種子', nightBlockA.includes('豆豆') && nightBlockA.includes('夢裡浮上心頭'))
  const diaryIsolation = await platformQuery<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM diaries WHERE tenant_id = $1`,
    [tenantB.id],
  )
  check('B 也有自己的日記（各戶各寫各的）', Number(diaryIsolation.rows[0].n) >= 1)

  // 誠實鏡子：宣稱成功但實際失敗 → 校正注入一次後消化
  await recordActionOutcome({
    tenantId: tenantA.id, userId: userA.id, actionType: 'card_made',
    claimedSuccess: true, actualSuccess: false, evidence: '生日卡',
  })
  const reflections = await nightlyHonestyReflection(() => {})
  check('夜間自省寫入 honesty_notes', reflections >= 1)
  const correction1 = await buildTruthCorrection(tenantA.id, userA.id)
  check('真相校正注入（含自省筆記）', correction1.includes('誠實鏡子') && correction1.includes('誠實自省'))
  const correction2 = await buildTruthCorrection(tenantA.id, userA.id)
  check('校正只注入一次（第二次為空）', correction2 === '')
  await recordActionOutcome({
    tenantId: tenantA.id, userId: userA.id, actionType: 'voice_sent',
    claimedSuccess: true, actualSuccess: true,
  })
  const correction3 = await buildTruthCorrection(tenantA.id, userA.id)
  check('真的做到的事絕不進校正', correction3 === '')

  console.log('\n— 向量記憶層（fail-closed 語意搜尋）—')
  const { setEmbedOverride, indexMemory, semanticSearch, buildSemanticBlock } = await import(
    '../src/modules/memory/vector.js'
  )

  // 假 embedding：狗類詞彙 → [1,0]、運動類 → [0,1]（確定性 cosine）
  setEmbedOverride(async (texts: string[]) =>
    texts.map((t) => (/狗|柴犬|豆豆|毛小孩/.test(t) ? [1, 0] : /瑜伽|運動|拉筋/.test(t) ? [0, 1] : [0.5, 0.5])),
  )
  await indexMemory(tenantA.id, 'learned_fact', 90001, '[fact] 對方養了一隻柴犬叫豆豆')
  await indexMemory(tenantA.id, 'learned_fact', 90002, '[fact] 對方喜歡喝黑咖啡')
  await indexMemory(tenantB.id, 'learned_fact', 90003, '[fact] 對方每週二晚上上瑜伽課')

  const hitsA = await semanticSearch(tenantA.id, '我家毛小孩今天好可愛', 3)
  check('語意檢索：毛小孩 → 找到柴犬豆豆', hitsA.length > 0 && hitsA[0].content.includes('豆豆'))
  const hitsCross = await semanticSearch(tenantA.id, '瑜伽拉筋', 3)
  check('fail-closed：A 搜瑜伽撈不到 B 的記憶', !hitsCross.some((h) => h.content.includes('瑜伽')))
  const blockA = await buildSemanticBlock(tenantA.id, '毛小孩')
  check('brain 注入區塊格式正確', blockA.includes('語意想起來的') && blockA.includes('豆豆'))

  // 關鍵字 fallback（拔掉 embedding）
  setEmbedOverride(null) // geminiApiKey 未設 → 走 fallback
  const fallbackHits = await semanticSearch(tenantA.id, '柴犬豆豆', 3)
  check('無 embedding 時關鍵字 fallback 仍可檢索', fallbackHits.length > 0 && fallbackHits[0].content.includes('豆豆'))

  console.log('\n— 主動關懷（觸發＋護欄）—')
  const { runProactiveCare, markProactiveReplied } = await import('../src/modules/proactive/care.js')
  const DAY = 24 * 3600_000
  // 固定「現在」= 台北 15:00（避開安靜時段與夢種子時段）
  const now3pm = (() => {
    const d = new Date()
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 7, 0, 0) // UTC 07:00 = 台北 15:00
  })()

  // 補點（前面測試把 A 扣得差不多了）
  await grantPoints(tenantA.id, 100, { reason: 'admin_adjust', source: 'admin_adjust' })

  // idle 觸發：把 A 的對話時間改成 4 天前
  await platformQuery(`UPDATE conversations SET created_at = created_at - interval '4 days' WHERE tenant_id = $1`, [tenantA.id])
  const care1 = await runProactiveCare(() => {}, { nowMs: now3pm })
  check('idle 觸發：太久沒見 → 主動出聲', care1.sent >= 1)
  const careHist = await platformQuery<{ trigger_type: string }>(
    `SELECT trigger_type FROM proactive_history WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [tenantA.id],
  )
  check('proactive_history 落帳（trigger=idle）', careHist.rows[0]?.trigger_type === 'idle')

  // 護欄：72h 內不再主動
  const care2 = await runProactiveCare(() => {}, { nowMs: now3pm + 3600_000 })
  check('護欄：72h 內同一人不再主動', care2.sent === 0)
  // 護欄：安靜時段（台北 02:00）
  const care3 = await runProactiveCare(() => {}, { nowMs: now3pm + 11 * 3600_000 }) // 台北 02:00
  check('護欄：安靜時段（23-07）不出聲', care3.skipped.includes('quiet_hours'))
  // 護欄：總開關
  await platformQuery(`UPDATE system_settings SET value = 'false' WHERE key = 'proactive_outreach_enabled'`)
  const care4 = await runProactiveCare(() => {}, { nowMs: now3pm })
  check('護欄：master switch 關 → 全停', care4.skipped.includes('master_switch_off'))
  await platformQuery(`UPDATE system_settings SET value = 'true' WHERE key = 'proactive_outreach_enabled'`)
  // 回話 → 已讀不回歸零
  await markProactiveReplied(tenantA.id, userA.id)
  const replied = await platformQuery<{ got_reply: boolean }>(
    `SELECT got_reply FROM proactive_history WHERE tenant_id = $1 ORDER BY sent_at DESC LIMIT 1`,
    [tenantA.id],
  )
  check('對方回話 → 最近一筆主動標 got_reply', replied.rows[0]?.got_reply === true)

  console.log('\n— 共讀 session 落地 —')
  const reading = await import('../src/modules/proactive/reading.js')

  setLlmOverride(async (req: LlmRequest) => {
    const userMsg = String(req.messages[req.messages.length - 1]?.content ?? '')
    if (userMsg.includes('共讀規劃員')) {
      return {
        text: JSON.stringify({
          segments: [
            { seg: 1, title: '什麼是瑜伽', refs: '1.1–1.4' },
            { seg: 2, title: '心的波動', refs: '1.5–1.11' },
            { seg: 3, title: '練習與放下', refs: '1.12–1.16' },
          ],
        }),
        usage: { input_tokens: 10, output_tokens: 10 },
      }
    }
    return { text: '{"note":false}', usage: { input_tokens: 5, output_tokens: 5 } }
  })

  check('偵測開書句', reading.detectStartBook('我們一起讀《瑜伽經》好不好') === '瑜伽經')
  check('偵測模式指令', reading.detectModeCommand('導讀模式 A') === 'A')
  const planStarted = await reading.startReadingPlan(tenantA.id, '瑜伽經')
  check('開書：建計畫＋LLM 分段地圖', planStarted)
  const planDup = await reading.startReadingPlan(tenantA.id, '瑜伽經')
  check('同書不重複開', !planDup)
  check('切模式 A', await reading.setReadingMode(tenantA.id, 'A'))

  // [NOTE] 標籤 → 筆記入庫＋進度推進（走 actionTags 全路徑）
  const noteReply =
    '那我把這段記下來囉。\n[NOTE seg="1" chapter="三摩地品" title="什麼是瑜伽" refs="1.1–1.4" partner="他說靜下來很難"]' +
    '今天我們讀了第一段。他說靜下來很難，我們的體會是：看見心在動，就已經是靜的開始。[/NOTE]'
  const noteResult = await applyActionTags(tenantA.id, userA.id, noteReply, '我覺得靜下來好難')
  check('NOTE 標籤 → 筆記入庫', noteResult.noteSaved)
  check('NOTE 區塊從顯示文字剝除', !noteResult.cleanText.includes('[NOTE') && noteResult.cleanText.includes('記下來囉'))
  const planRow = await platformQuery<{ cur_segment: number; mode: string }>(
    `SELECT cur_segment, mode FROM reading_plans WHERE tenant_id = $1 AND status = 'active'`,
    [tenantA.id],
  )
  check('筆記後進度推進到第 2 段', Number(planRow.rows[0]?.cur_segment) === 2 && planRow.rows[0]?.mode === 'A')

  const readingBlock = await reading.buildReadingBlock(tenantA.id)
  check(
    '注入區塊：模式＋進度＋筆記＋防否認',
    readingBlock.includes('【導讀模式：A】') &&
      readingBlock.includes('第 2 段') &&
      readingBlock.includes('心的波動') &&
      readingBlock.includes('別否認'),
  )
  const readingBlockB = await reading.buildReadingBlock(tenantB.id)
  check('B 戶沒開書 → 無共讀區塊（隔離）', readingBlockB === '')

  setLlmOverride(null)

  console.log('\n— 多角色：一人養兩角色、零串門 —')
  const { getCharacterForTenant, invalidateCharacterCache } = await import('../src/modules/characters.js')

  const kkRes = await platformQuery<{ id: number }>(
    `INSERT INTO characters (slug, name, tagline, soul_pack)
     VALUES ('kuaikuai', '快快', '想到就說，快快都接得住。', 'soul/packs/kuaikuai')
     RETURNING id`,
  )
  const kuaikuaiId = kkRes.rows[0].id
  invalidateCharacterCache()

  // 阿明已有慢慢戶 → 再開快快戶（新唯一索引：user × character）
  let tenantK = await createTenantForUser(userA.id, kuaikuaiId)
  check('同一人可再開第二角色的戶', tenantK.character_id === kuaikuaiId)

  // 同角色第二戶 → 被唯一索引擋下
  let dupBlocked = false
  try {
    await createTenantForUser(userA.id, kuaikuaiId)
  } catch {
    dupBlocked = true
  }
  check('同角色重複開戶被唯一索引擋下', dupBlocked)

  // 路由：預設（饅頭）回饅頭戶；指定快快回快快戶
  const memDefault = await resolveMembership(userA.id)
  check('resolveMembership 預設回饅頭戶', memDefault?.tenant.id === tenantA.id)
  const memKK = await resolveMembership(userA.id, kuaikuaiId)
  check('resolveMembership 指定角色回快快戶', memKK?.tenant.id === tenantK.id)

  // 快快的啟元儀式：名字是快快、不是慢慢
  await stepGenesis(tenantK, userA.display_name, '哈囉')
  tenantK = await reloadTenant(tenantK.id)
  const kkNaming = await stepGenesis(tenantK, userA.display_name, '明哥')
  check('快快儀式用自己的名字', kkNaming.texts.join('').includes('我叫快快') && !kkNaming.texts.join('').includes('慢慢'))
  tenantK = await reloadTenant(tenantK.id)
  const kkBorn = await stepGenesis(tenantK, userA.display_name, '就叫快快')
  tenantK = await reloadTenant(tenantK.id)
  check('快快誕生（含 pack 的 tagline）', tenantK.status === 'active' && kkBorn.texts.join('').includes('快快都接得住'))
  const charK = await getCharacterForTenant(tenantK)
  const charA2 = await getCharacterForTenant(tenantA)
  check('角色解析：兩戶各自的角色', charK.slug === 'kuaikuai' && charA2.slug === 'mantou')

  // 兩戶記憶零串門（同一個人、兩個角色）
  const dbK = forTenant(tenantK.id)
  await dbK.query(
    `INSERT INTO conversations (tenant_id, user_id, user_message, ai_response) VALUES ($1, $2, $3, $4)`,
    [userA.id, '快快我跟你說個秘密', '嗯！我聽著。'],
  )
  const aConvs = await dbA.query<{ user_message: string }>(
    `SELECT user_message FROM conversations WHERE tenant_id = $1`,
  )
  check('饅頭戶撈不到快快戶的對話（同人跨角色零串門）', !aConvs.rows.some((r) => r.user_message?.includes('秘密')))

  console.log(`\n═══ 驗收結果：${passed} 過 / ${failed} 敗 ═══`)
  await pool.end()
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error('acceptance crashed:', err)
  process.exit(1)
})
