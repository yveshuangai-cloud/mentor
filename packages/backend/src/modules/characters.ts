import { platformQuery } from '../db/index.js'
import type { TenantRow } from './tenancy.js'

/**
 * 🎭 角色註冊表（多角色最小改造 · BRIEF-FOR-ADAM §3）。
 * 角色＝一個 soul pack；記憶／計費／夜間靈魂全部 character-agnostic（掛 tenant）。
 * 平台預設角色 = 慢慢（manman）；tenants.character_id 為 NULL 的舊戶一律視為慢慢。
 */

export interface CharacterRow {
  id: number
  slug: string
  name: string
  tagline: string | null
  soul_pack: string
  voice_id: string | null
  avatar_prompt: string | null
  status: 'active' | 'draft' | 'retired'
}

const cache = new Map<string, CharacterRow>() // key: slug 與 `id:<n>` 雙鍵
let cachedAt = 0
const TTL_MS = 60_000

async function loadAll(): Promise<void> {
  if (cache.size && Date.now() - cachedAt < TTL_MS) return
  const r = await platformQuery<CharacterRow>(`SELECT * FROM characters WHERE status != 'retired'`)
  cache.clear()
  for (const row of r.rows) {
    cache.set(row.slug, row)
    cache.set(`id:${row.id}`, row)
  }
  cachedAt = Date.now()
}

export function invalidateCharacterCache(): void {
  cache.clear()
  cachedAt = 0
}

export async function getCharacterBySlug(slug: string): Promise<CharacterRow | null> {
  await loadAll()
  return cache.get(slug) ?? null
}

export async function getDefaultCharacter(): Promise<CharacterRow> {
  const manman = await getCharacterBySlug('manman')
  if (!manman) throw new Error('characters 表缺 manman（migration 001 應已種入）')
  return manman
}

/** tenant → 角色；舊戶（character_id NULL）視為慢慢 */
export async function getCharacterForTenant(
  tenant: Pick<TenantRow, 'character_id'>,
): Promise<CharacterRow> {
  await loadAll()
  if (tenant.character_id != null) {
    const hit = cache.get(`id:${tenant.character_id}`)
    if (hit) return hit
  }
  return getDefaultCharacter()
}
