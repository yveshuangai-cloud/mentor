import { platformQuery } from '../db/index.js'
import type { TenantRow } from './tenancy.js'

/**
 * 🎭 角色註冊表（多角色最小改造 · BRIEF-FOR-ADAM §3）。
 * 角色＝一個 soul pack；記憶／計費／夜間靈魂全部 character-agnostic（掛 tenant）。
 * 饅頭專用 OA 的預設角色 = 饅頭（mantou）。
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
  const mantou = await getCharacterBySlug('mantou')
  if (!mantou) throw new Error('characters 表缺 mantou（migration 003 應已種入）')
  return mantou
}

/** tenant → 角色；未綁角色時使用此 OA 的預設饅頭 */
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
