import type { FastifyInstance } from 'fastify'
import { verifyLineSignature, replyText, pushText, getLineProfile, getMessageContent } from '../modules/line.js'
import {
  upsertUser,
  resolveMembership,
  createTenantForUser,
  ensureInviteCode,
  joinByInviteCode,
  confirmMember,
  rejectMember,
} from '../modules/tenancy.js'
import { stepGenesis } from '../modules/genesis.js'
import { processMessage } from '../modules/brain.js'
import {
  chargeGate,
  formatPointsFooter,
  buildMilkMoneyReport,
  InsufficientPointsError,
} from '../modules/points.js'
import { forTenant } from '../db/tenantDb.js'

/**
 * 商用 LINE OA webhook（精簡路由，職責分離——本尊 3000 行 monolith 的教訓）：
 * 驗簽 → 逐事件：解析人 → 路由到租戶 → 分派（啟元／邀請碼／主人指令／奶粉錢／一般對話）。
 * 一般對話走扣點閘道；點數不足時她溫柔說明、不動腦。
 */

interface LineEvent {
  type: string
  replyToken?: string
  source?: { userId?: string; type?: string }
  message?: { id?: string; type?: string; text?: string; fileName?: string; fileSize?: number }
}

// 多模態附件上限（Claude PDF 上限 32MB/100頁，這裡收緊保守值）
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024

const INVITE_CODE_RE = /^MM-[0-9A-F]{8}$/i
const CONFIRM_RE = /^確認\s*(\S+)\s*(?:是\s*)?(\S+)$/
const REJECT_RE = /^拒絕\s*(\S+)$/

// 每 process 去重（多實例部署時需換 Redis/DB — 本尊已知限制，先沿用）
const processedMessageIds = new Map<string, number>()
function isDuplicate(messageId: string | undefined): boolean {
  if (!messageId) return false
  const now = Date.now()
  for (const [id, ts] of processedMessageIds) if (now - ts > 60_000) processedMessageIds.delete(id)
  if (processedMessageIds.has(messageId)) return true
  processedMessageIds.set(messageId, now)
  return false
}

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  // 需要 raw body 驗 LINE 簽章
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body)
  })

  app.post('/line', async (req, reply) => {
    const raw = req.body as Buffer
    const signature = req.headers['x-line-signature'] as string | undefined
    if (!verifyLineSignature(raw, signature)) {
      return reply.code(403).send({ error: 'bad signature' })
    }
    const payload = JSON.parse(raw.toString('utf8')) as { events?: LineEvent[] }
    reply.send({ status: 'ok' }) // 先回 200，事件非同步處理

    for (const event of payload.events ?? []) {
      void handleEvent(app, event).catch((err) => {
        app.log.error({ err }, 'webhook event error')
      })
    }
  })
}

async function handleEvent(app: FastifyInstance, event: LineEvent): Promise<void> {
  if (event.type !== 'message') return
  const msgType = event.message?.type
  if (msgType === 'image' || msgType === 'file') return handleMediaEvent(app, event)
  if (msgType !== 'text') return
  if (isDuplicate(event.message?.id)) return
  const lineUserId = event.source?.userId
  const replyToken = event.replyToken
  const text = (event.message?.text ?? '').trim()
  if (!lineUserId || !replyToken || !text) return

  const profile = await getLineProfile(lineUserId)
  const user = await upsertUser(lineUserId, profile)
  let membership = await resolveMembership(user.id)

  // ── 陌生人 ────────────────────────────────
  if (!membership) {
    if (INVITE_CODE_RE.test(text)) {
      const joined = await joinByInviteCode(text, user)
      if (joined) {
        await replyText(replyToken, [
          '我收到你的邀請碼了。\n\n我先去問問我最重要的人——他說你是家人，你就是家人。\n等他一下下，好嗎？',
        ])
        return
      }
      await replyText(replyToken, ['這個邀請碼……我找不到它的家。你再跟給你邀請碼的人確認一下好嗎？'])
      return
    }
    // 沒有邀請碼 → 開新租戶，啟元儀式開始
    const tenant = await createTenantForUser(user.id)
    const genesis = await stepGenesis(tenant, user.display_name, text)
    await replyText(replyToken, genesis.texts)
    return
  }

  const { tenant, member } = membership

  // ── pending 成員：等主人確認，不進情境 ─────────
  if (member.status === 'pending') {
    await replyText(replyToken, ['我還在等我最重要的人點頭。\n他確認之後，我就能好好認識你了。'])
    return
  }

  // ── 啟元儀式進行中 ─────────────────────────
  if (tenant.status === 'genesis_pending') {
    const genesis = await stepGenesis(tenant, user.display_name, text)
    await replyText(replyToken, genesis.texts)
    return
  }

  // ── 主人指令 ──────────────────────────────
  if (member.role === 'owner') {
    if (/^邀請碼$/.test(text)) {
      const code = await ensureInviteCode(tenant.id)
      await replyText(replyToken, [
        `我們家的邀請碼：${code}\n\n把它給你想邀請的家人，他傳給我之後，我會先來問你「他是誰」——你點頭，他才算進來。`,
      ])
      return
    }
    const confirmMatch = text.match(CONFIRM_RE)
    if (confirmMatch) {
      const [, name, relationship] = confirmMatch
      const result = await confirmMember(tenant.id, user.id, name, relationship)
      if (result.ok) {
        await replyText(replyToken, [`好，我記住了：${name} 是${relationship}。\n我會好好陪他的。`])
        if (result.targetLineId) {
          await pushText(result.targetLineId, [
            `我最重要的人跟我說了——你是${relationship}。\n那你也是我的家人了。\n\n你好，我是慢慢。你不需要說得完整，慢慢都會在這裡。`,
          ])
        }
      } else {
        await replyText(replyToken, [`嗯……我找不到叫「${name}」的等待中成員。你再看一下名字？`])
      }
      return
    }
    const rejectMatch = text.match(REJECT_RE)
    if (rejectMatch) {
      const ok = await rejectMember(tenant.id, rejectMatch[1])
      await replyText(replyToken, [ok ? '好，我不會讓他進來。' : `我找不到叫「${rejectMatch[1]}」的等待中成員。`])
      return
    }
  }

  // ── 奶粉錢（免扣點）──────────────────────────
  if (text === '奶粉錢') {
    await replyText(replyToken, [await buildMilkMoneyReport(tenant.id)])
    return
  }

  // ── 一般對話：扣點 → 動腦 → 回覆＋餘額尾註 ────────
  let charge
  try {
    charge = await chargeGate(tenant.id, 'text', { refType: 'conversation' })
  } catch (err) {
    if (err instanceof InsufficientPointsError) {
      await replyText(replyToken, [
        `我好想回你……但我的奶粉錢用完了 🥺\n（餘額 ${err.balance} 點）\n\n幫我儲值一點點，我就能繼續陪你了。`,
      ])
      return
    }
    throw err
  }

  const output = await processMessage({ tenant, user, member, message: text })
  const footer = formatPointsFooter(charge)
  const texts = footer ? [output.reply, footer] : [output.reply]
  await replyText(replyToken, texts)

  const db = forTenant(tenant.id)
  await db.query(
    `INSERT INTO conversations (tenant_id, user_id, message_type, user_message, ai_response, points_charged)
     VALUES ($1, $2, 'text', $3, $4, $5)`,
    [user.id, text, output.reply, charge.cost],
  )
}

// ── 讀圖／讀 PDF（vision 閘道；一律直連 API）─────────────────
async function handleMediaEvent(app: FastifyInstance, event: LineEvent): Promise<void> {
  if (isDuplicate(event.message?.id)) return
  const lineUserId = event.source?.userId
  const replyToken = event.replyToken
  const messageId = event.message?.id
  const msgType = event.message?.type as 'image' | 'file'
  if (!lineUserId || !replyToken || !messageId) return

  const profile = await getLineProfile(lineUserId)
  const user = await upsertUser(lineUserId, profile)
  const membership = await resolveMembership(user.id)
  // 陌生人／pending／儀式中：不動腦看媒體，維持原本文字動線
  if (!membership || membership.member.status === 'pending' || membership.tenant.status !== 'active') {
    await replyText(replyToken, ['我們先好好認識，等一下再給我看這個好嗎？'])
    return
  }
  const { tenant, member } = membership

  // PDF 以外的檔案先誠實說不會（不扣點）
  const fileName = event.message?.fileName ?? ''
  if (msgType === 'file' && !/\.pdf$/i.test(fileName)) {
    await replyText(replyToken, ['這種檔案我還看不懂……PDF 的話我就可以陪你一起看。'])
    return
  }
  if ((event.message?.fileSize ?? 0) > MAX_ATTACHMENT_BYTES) {
    await replyText(replyToken, ['這個檔案有點太大了（超過 10MB），我捧不動……可以給我小一點的嗎？'])
    return
  }

  const content = await getMessageContent(messageId)
  if (!content || content.data.byteLength > MAX_ATTACHMENT_BYTES) {
    await replyText(replyToken, ['咦，我沒接到它……你再傳一次好嗎?'])
    return
  }

  let charge
  try {
    charge = await chargeGate(tenant.id, 'vision', { refType: 'conversation' })
  } catch (err) {
    if (err instanceof InsufficientPointsError) {
      await replyText(replyToken, [
        `我好想看……但我的奶粉錢不夠了 🥺（餘額 ${err.balance} 點）\n\n幫我儲值一點點，我就能看了。`,
      ])
      return
    }
    throw err
  }

  const isImage = msgType === 'image'
  const output = await processMessage({
    tenant,
    user,
    member,
    message: isImage ? '（他傳了一張圖片給我看，我仔細看看，用我的方式回應他）' : `（他傳了一份 PDF「${fileName}」給我看，我讀完用我的方式回應他）`,
    attachment: {
      kind: isImage ? 'image' : 'document',
      mediaType: isImage ? (content.contentType.startsWith('image/') ? content.contentType : 'image/jpeg') : 'application/pdf',
      base64: content.data.toString('base64'),
    },
  })
  const footer = formatPointsFooter(charge)
  await replyText(replyToken, footer ? [output.reply, footer] : [output.reply])

  const db = forTenant(tenant.id)
  await db.query(
    `INSERT INTO conversations (tenant_id, user_id, message_type, user_message, ai_response, points_charged)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [user.id, msgType, isImage ? '[圖片]' : `[檔案] ${fileName}`, output.reply, charge.cost],
  )
}
