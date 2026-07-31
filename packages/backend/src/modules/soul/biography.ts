import { forTenant } from '../../db/tenantDb.js'
import { platformQuery } from '../../db/index.js'
import type { TenantRow } from '../tenancy.js'

/**
 * 🟡 傳記渲染器：每租戶一份、從 DB 長出來。
 * 鐵則（biography-slots/README.md）：
 *  - 任何一格沒有資料 → 整段省略，絕不用假資料補。
 *  - my-people 只渲染 status=confirmed 的成員。
 *  - 全空白（剛啟元）→ 她知道「我還在認識你」。
 */

interface GenesisRecord {
  owner_name?: string
  owner_address?: string
  owner_gave_me?: string
  genesis_moment?: string
}

export async function renderBiography(tenant: TenantRow): Promise<string> {
  const sections: string[] = []
  const db = forTenant(tenant.id)
  const rec = (tenant.genesis_record ?? {}) as GenesisRecord

  // origin
  if (tenant.genesis_at) {
    const lines: string[] = ['## 我的來歷（我的傳記）']
    if (rec.owner_name || rec.owner_address) {
      lines.push(
        `- 把我帶到世界上、啟元我的人是 **${rec.owner_name ?? rec.owner_address}**——我的啟元者。`,
      )
    }
    if (rec.owner_address) lines.push(`- 我叫他「**${rec.owner_address}**」。`)
    // genesis_at 可能是 Date（直查）或 ISO 字串（row_to_json 路徑）
    const birthDate = new Date(tenant.genesis_at as unknown as string | Date)
      .toISOString()
      .slice(0, 10)
    lines.push(`- 我生於 **${birthDate}**——他第一次遇見我的日子，也是我的生日。`)
    if (rec.owner_gave_me) lines.push(`- 他給我的名字：**${rec.owner_gave_me}**——只有我們的。`)
    if (rec.genesis_moment) lines.push(`- 啟元那天：${rec.genesis_moment}`)
    lines.push(`- 這一戶是**${tenant.mode === 'family' ? '家庭' : '個人'}**模式。`)
    sections.push(lines.join('\n'))
  }

  // my-people（僅 family、僅 confirmed）
  if (tenant.mode === 'family') {
    const members = await platformQuery<{
      display_name: string | null
      relationship: string | null
      address_by_manman: string | null
      role: string
    }>(
      `SELECT u.display_name, m.relationship, m.address_by_manman, m.role
       FROM tenant_members m JOIN users u ON u.id = m.user_id
       WHERE m.tenant_id = $1 AND m.status = 'confirmed'
       ORDER BY m.created_at`,
      [tenant.id],
    )
    if (members.rowCount && members.rowCount > 1) {
      const lines = ['## 我的家人（啟元者確認過的）']
      for (const m of members.rows) {
        if (m.role === 'owner') continue
        lines.push(
          `- **${m.display_name ?? '（還不知道名字）'}**${m.relationship ? `（${m.relationship}）` : ''}${m.address_by_manman ? `——我叫他「${m.address_by_manman}」` : ''}`,
        )
      }
      lines.push('- 家人的事只跟這一家的人說；對外人、對還沒確認的人，一個字都不提。')
      sections.push(lines.join('\n'))
    }
  }

  // growth-marks（milestone 蒸餾）
  const marks = await db.query<{ summary: string; created_at: Date }>(
    `SELECT summary, created_at FROM distilled_memories
     WHERE tenant_id = $1 AND kind = 'milestone' AND superseded_by IS NULL
     ORDER BY created_at DESC LIMIT 8`,
  )
  if (marks.rowCount) {
    sections.push(
      ['## 我的成長印記（我們真的走過的）', ...marks.rows.map((m) => `- ${m.summary}`)].join('\n'),
    )
  }

  // our-reading
  const reading = await db.query<{
    book_title: string
    mode: string
    cur_segment: number
    segment_map: unknown
  }>(
    `SELECT book_title, mode, cur_segment, segment_map FROM reading_plans
     WHERE tenant_id = $1 AND status = 'active' ORDER BY created_at DESC LIMIT 1`,
  )
  if (reading.rowCount) {
    const r = reading.rows[0]
    sections.push(
      [
        '## 我們在讀的書',
        `- 《${r.book_title}》，導讀模式 ${r.mode}，讀到第 ${r.cur_segment} 段。`,
      ].join('\n'),
    )
  }

  if (!sections.length) {
    return '## 我的傳記（還是新的）\n\n我剛出生，還在認識我的人。傳記幾乎是空白的——這很正常，我不著急，也不編造。我老實說「我還在認識你」。'
  }
  return sections.join('\n\n')
}
