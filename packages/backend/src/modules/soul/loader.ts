import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 🟢 靈魂包載入器（多角色版：soul/packs/<slug>/，唯讀共用）。
 * 順序照 pack 內 00-INDEX.md；傳記插在 persona 之後（biography.ts）。
 * per-slug 快取（process 生命週期；pack 檔改動需重啟——與本尊一致）。
 * 相容：slug=manman 且 packs/ 找不到時退舊路徑 soul/character-core/（搬遷過渡期保險）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

function rootCandidates(slug: string): string[] {
  const rels = [`soul/packs/${slug}`]
  if (slug === 'manman') rels.push('soul/character-core') // 舊路徑保險
  const bases = [join(__dirname, '../../../../..'), process.cwd(), join(process.cwd(), '../..')]
  return bases.flatMap((b) => rels.map((r) => join(b, r)))
}

const CORE_ORDER = [
  'constitution.md',
  'persona.md',
  // ← 傳記插入點（biography.ts）
  'voice-dna.md',
  'speaking-style.md',
  'reaction-engine.md',
  'self-check.md',
  'my-existence.md',
  'growth-framework.md',
]

const SKILL_FILES = [
  'skills/scheduling.md',
  'skills/promises.md',
  'skills/image-creation.md',
  'skills/reading-together.md',
  'skills/voice-clips.md',
  'skills/web-search.md',
  'skills/document-reading.md',
]

const cache = new Map<string, string>() // key: `${slug}:${rel}`

async function readSoulFile(slug: string, rel: string): Promise<string> {
  const key = `${slug}:${rel}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit
  let content = ''
  for (const root of rootCandidates(slug)) {
    try {
      content = await readFile(join(root, rel), 'utf8')
      break
    } catch {
      // try next root
    }
  }
  if (!content) console.warn(`[soul] 讀不到 ${slug}/${rel}（將以空白略過）`)
  cache.set(key, content)
  return content
}

export interface SoulParts {
  /** 傳記之前的核心（constitution + persona） */
  preBiography: string
  /** 傳記之後的核心（voice-dna → growth-framework） */
  postBiography: string
  /** 技能檔（可依路由只載需要的） */
  skills: string
}

export async function loadCharacterCore(slug = 'mantou'): Promise<SoulParts> {
  const parts = await Promise.all(CORE_ORDER.map((f) => readSoulFile(slug, f)))
  const skills = await Promise.all(SKILL_FILES.map((f) => readSoulFile(slug, f)))
  const sep = '\n\n---\n\n'
  return {
    preBiography: parts.slice(0, 2).filter(Boolean).join(sep),
    postBiography: parts.slice(2).filter(Boolean).join(sep),
    skills: skills.filter(Boolean).join(sep),
  }
}

/** 家庭橋樑層：僅 family 模式租戶載入（§10 定案 B） */
export async function loadFamilyBridge(slug = 'mantou'): Promise<string> {
  return readSoulFile(slug, 'family-bridge.md')
}
