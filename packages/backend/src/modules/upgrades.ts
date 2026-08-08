import { platformQuery } from '../db/index.js'

export const AUTHORIZED_UPGRADE_PROMPT = `# 饅頭升級需求記錄
這位對話者是唯一有權校準饅頭靈魂與知識方向的人之一。
當他明確要求調整、關閉、新增、修正或升級「饅頭本身」時，在自然回覆最後附上一個不可見動作標籤：
[UPGRADE_REQUEST title="20字內標題" details="完整但精簡的要求"]
不要把一般問題、聊天內容或對朋友的建議誤記成產品升級。標籤之外一定要有至少一句自然可見的回覆。`

export interface UpgradeRequestRow {
  id: number
  title: string
  details: string
  status: string
  created_at: Date
}

export function parseUpgradeRequestTag(text: string): { title: string; details: string } | null {
  const match = text.match(/\[UPGRADE_REQUEST\b([^\]]*)\]/i)
  if (!match) return null
  const attrs = match[1]
  const get = (name: string) =>
    (attrs.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, 'i'))?.[1] ?? '').trim()
  const title = get('title').slice(0, 80)
  const details = (get('details') || title).slice(0, 1000)
  return title ? { title, details } : null
}

export function stripUpgradeRequestTags(text: string): string {
  return text.replace(/\[UPGRADE_REQUEST\b[^\]]*\]/gi, '').replace(/\n{3,}/g, '\n\n').trim()
}

export async function recordUpgradeRequest(input: {
  tenantId: number
  userId: number
  title: string
  details: string
  source?: string
}): Promise<number> {
  const existing = await platformQuery<{ id: number }>(
    `SELECT id FROM soul_upgrade_requests
     WHERE tenant_id = $1 AND status NOT IN ('completed', 'rejected')
       AND lower(title) = lower($2)
     ORDER BY created_at DESC LIMIT 1`,
    [input.tenantId, input.title],
  )
  if (existing.rows[0]) return existing.rows[0].id
  const inserted = await platformQuery<{ id: number }>(
    `INSERT INTO soul_upgrade_requests
       (tenant_id, requested_by_user_id, title, details, source)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [input.tenantId, input.userId, input.title, input.details, input.source ?? 'line'],
  )
  return inserted.rows[0].id
}

export async function listOpenUpgradeRequests(limit = 20): Promise<UpgradeRequestRow[]> {
  const result = await platformQuery<UpgradeRequestRow>(
    `SELECT id, title, details, status, created_at
     FROM soul_upgrade_requests
     WHERE status NOT IN ('completed', 'rejected')
     ORDER BY CASE status
       WHEN 'in_progress' THEN 1 WHEN 'approved' THEN 2 WHEN 'planned' THEN 3 ELSE 4 END,
       created_at ASC
     LIMIT $1`,
    [limit],
  )
  return result.rows
}

export function formatUpgradeBacklog(rows: UpgradeRequestRow[]): string {
  if (!rows.length) return '目前沒有待處理的升級需求。'
  const statusLabel: Record<string, string> = {
    proposed: '待評估', planned: '已規劃', approved: '已批准', in_progress: '處理中',
  }
  return ['饅頭升級清單：', ...rows.map((r) => `#${r.id}［${statusLabel[r.status] ?? r.status}］${r.title}`)].join('\n')
}
