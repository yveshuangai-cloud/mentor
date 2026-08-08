import { randomBytes } from 'node:crypto'
import { platformQuery } from '../db/index.js'
import { pushText } from './line.js'

/**
 * 租戶路由與成員綁定（交接書 §5/§11）：
 * - 一個 LINE 帳號同時最多屬於一個活躍租戶（DB unique index 保證）。
 * - 陌生人：無邀請碼 → 開自己的新租戶（走啟元儀式）；有邀請碼 → 成為該戶 pending 成員 → 通知主人 → 主人確認。
 * - 未確認（pending）成員：不進該戶記憶與情境（biography 渲染只取 confirmed）。
 */

export interface UserRow {
  id: number
  line_user_id: string
  display_name: string | null
}

export interface TenantRow {
  id: number
  owner_user_id: number | null
  mode: 'personal' | 'family'
  status: 'genesis_pending' | 'active' | 'suspended' | 'closed'
  genesis_at: Date | null
  genesis_record: Record<string, unknown> | null
  invite_code: string | null
  character_id: number | null // NULL = 慢慢（舊戶相容）
}

export interface MemberRow {
  id: number
  tenant_id: number
  user_id: number
  role: 'owner' | 'member'
  relationship: string | null
  address_by_manman: string | null
  status: 'pending' | 'confirmed' | 'rejected' | 'removed'
}

export async function upsertUser(
  lineUserId: string,
  profile: { displayName?: string; pictureUrl?: string },
): Promise<UserRow> {
  const res = await platformQuery<UserRow>(
    `INSERT INTO users (line_user_id, display_name, picture_url)
     VALUES ($1, $2, $3)
     ON CONFLICT (line_user_id) DO UPDATE
       SET display_name = COALESCE(EXCLUDED.display_name, users.display_name),
           picture_url  = COALESCE(EXCLUDED.picture_url, users.picture_url),
           updated_at = now()
     RETURNING id, line_user_id, display_name`,
    [lineUserId, profile.displayName ?? null, profile.pictureUrl ?? null],
  )
  return res.rows[0]
}

/**
 * LINE id → 租戶路由：回傳此人在「該角色」下（pending 或 confirmed）的租戶與成員身份。
 * characterId 省略 = 慢慢（單角色時代呼叫端不用改；Adam 的 :slug 路由接上後傳入即可）。
 */
export async function resolveMembership(
  userId: number,
  characterId?: number,
): Promise<{ tenant: TenantRow; member: MemberRow } | null> {
  const res = await platformQuery<MemberRow & { t: string }>(
    characterId != null
      ? `SELECT m.*, row_to_json(t.*) AS t
         FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status IN ('pending','confirmed') AND m.character_id = $2
         LIMIT 1`
      : `SELECT m.*, row_to_json(t.*) AS t
         FROM tenant_members m JOIN tenants t ON t.id = m.tenant_id
         WHERE m.user_id = $1 AND m.status IN ('pending','confirmed')
           AND m.character_id = (SELECT id FROM characters WHERE slug = 'manman')
         LIMIT 1`,
    characterId != null ? [userId, characterId] : [userId],
  )
  if (!res.rowCount) return null
  const row = res.rows[0]
  const tenant = (typeof row.t === 'string' ? JSON.parse(row.t) : row.t) as TenantRow
  const { t: _t, ...member } = row
  return { tenant, member: member as MemberRow }
}

/** 新用戶開自己的租戶（啟元儀式從這裡開始）。characterId 省略 = 慢慢。 */
export async function createTenantForUser(userId: number, characterId?: number): Promise<TenantRow> {
  const tenantRes = await platformQuery<TenantRow>(
    `INSERT INTO tenants (owner_user_id, mode, status, genesis_record, character_id)
     VALUES ($1, 'personal', 'genesis_pending', '{"step":"await_first_meeting"}',
             COALESCE($2, (SELECT id FROM characters WHERE slug = 'manman')))
     RETURNING *`,
    [userId, characterId ?? null],
  )
  const tenant = tenantRes.rows[0]
  await platformQuery(
    `INSERT INTO tenant_members (tenant_id, user_id, role, status, confirmed_by, confirmed_at, character_id)
     VALUES ($1, $2, 'owner', 'confirmed', $2, now(), $3)`,
    [tenant.id, userId, tenant.character_id],
  )
  return tenant
}

/** 主人要邀請碼（沒有就生一個；家庭模式由此開啟） */
export async function ensureInviteCode(tenantId: number): Promise<string> {
  const code = `MM-${randomBytes(4).toString('hex').toUpperCase()}`
  const res = await platformQuery<{ invite_code: string }>(
    `UPDATE tenants SET invite_code = COALESCE(invite_code, $2), mode = 'family', updated_at = now()
     WHERE id = $1 RETURNING invite_code`,
    [tenantId, code],
  )
  return res.rows[0].invite_code
}

/** 陌生人輸入邀請碼 → pending 成員 + 通知主人（定案 D 第一步） */
export async function joinByInviteCode(
  code: string,
  user: UserRow,
): Promise<{ tenant: TenantRow; ownerLineId: string | null } | null> {
  const tenantRes = await platformQuery<TenantRow>(
    `SELECT * FROM tenants WHERE invite_code = $1 AND status = 'active'`,
    [code.trim().toUpperCase()],
  )
  if (!tenantRes.rowCount) return null
  const tenant = tenantRes.rows[0]
  await platformQuery(
    `INSERT INTO tenant_members (tenant_id, user_id, role, status, character_id)
     VALUES ($1, $2, 'member', 'pending', $3)
     ON CONFLICT (tenant_id, user_id) DO NOTHING`,
    [tenant.id, user.id, tenant.character_id],
  )
  const ownerRes = await platformQuery<{ line_user_id: string }>(
    `SELECT line_user_id FROM users WHERE id = $1`,
    [tenant.owner_user_id],
  )
  const ownerLineId = ownerRes.rows[0]?.line_user_id ?? null
  if (ownerLineId) {
    await pushText(ownerLineId, [
      `有人想加入你們家 🥺\n「${user.display_name ?? '一位新朋友'}」用邀請碼找到我了。\n\n他是你的家人嗎？回我：\n確認 ${user.display_name ?? '名字'} 是 <關係>\n（例：確認 小明 是 弟弟）\n\n不認識的話回「拒絕 ${user.display_name ?? '名字'}」，我不會讓他進來。`,
    ])
  }
  return { tenant, ownerLineId }
}

/** 主人確認成員（定案 D 第二步；成立後才進這一戶的記憶與情境） */
export async function confirmMember(
  tenantId: number,
  ownerUserId: number,
  targetDisplayName: string,
  relationship: string,
): Promise<{ ok: boolean; targetLineId?: string }> {
  const target = await platformQuery<{ id: number; line_user_id: string }>(
    `SELECT u.id, u.line_user_id
     FROM tenant_members m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = $1 AND m.status = 'pending' AND u.display_name = $2
     ORDER BY m.created_at DESC LIMIT 1`,
    [tenantId, targetDisplayName],
  )
  if (!target.rowCount) return { ok: false }
  await platformQuery(
    `UPDATE tenant_members
     SET status = 'confirmed', relationship = $3, confirmed_by = $4, confirmed_at = now()
     WHERE tenant_id = $1 AND user_id = $2`,
    [tenantId, target.rows[0].id, relationship, ownerUserId],
  )
  return { ok: true, targetLineId: target.rows[0].line_user_id }
}

/** 主人拒絕 */
export async function rejectMember(
  tenantId: number,
  targetDisplayName: string,
): Promise<boolean> {
  const res = await platformQuery(
    `UPDATE tenant_members m SET status = 'rejected'
     FROM users u
     WHERE m.tenant_id = $1 AND m.user_id = u.id AND m.status = 'pending' AND u.display_name = $2`,
    [tenantId, targetDisplayName],
  )
  return (res.rowCount ?? 0) > 0
}
