import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 🟢 character-core 載入器（唯讀共用）。
 * 順序照 soul/character-core/00-INDEX.md；傳記插在 persona 之後（由 biography.ts 渲染）。
 * process 生命週期內快取（soul 檔改動需重啟——與本尊一致）。
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

function soulRoot(): string {
  // repo 根目錄的 soul/character-core（dev: src/modules/soul → ../../../../../soul）
  const candidates = [
    join(__dirname, '../../../../../soul/character-core'),
    join(process.cwd(), 'soul/character-core'),
    join(process.cwd(), '../../soul/character-core'),
  ]
  return candidates[0]
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
]

const cache = new Map<string, string>()

async function readSoulFile(rel: string): Promise<string> {
  const hit = cache.get(rel)
  if (hit !== undefined) return hit
  let content = ''
  for (const root of [soulRoot(), join(process.cwd(), 'soul/character-core'), join(process.cwd(), '../../soul/character-core')]) {
    try {
      content = await readFile(join(root, rel), 'utf8')
      break
    } catch {
      // try next root
    }
  }
  if (!content) console.warn(`[soul] 讀不到 ${rel}（將以空白略過）`)
  cache.set(rel, content)
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

export async function loadCharacterCore(): Promise<SoulParts> {
  const parts = await Promise.all(CORE_ORDER.map(readSoulFile))
  const skills = await Promise.all(SKILL_FILES.map(readSoulFile))
  const sep = '\n\n---\n\n'
  return {
    preBiography: parts.slice(0, 2).filter(Boolean).join(sep),
    postBiography: parts.slice(2).filter(Boolean).join(sep),
    skills: skills.filter(Boolean).join(sep),
  }
}

/** 家庭橋樑層：僅 family 模式租戶載入（§10 定案 B） */
export async function loadFamilyBridge(): Promise<string> {
  return readSoulFile('family-bridge.md')
}
