/**
 * 🧪 角色包品質閘（BRIEF-FOR-ADAM §3 Q8）——過了 lint 才准 INSERT INTO characters。
 * 三道確定性檢查：完整性／平台安全底線未被刪改／PII 零命中。
 *
 * 跑法：npx tsx scripts/lint-pack.ts <slug>   （例：npx tsx scripts/lint-pack.ts manman）
 */
import { readFile, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const slug = process.argv[2]
if (!slug || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('用法：npx tsx scripts/lint-pack.ts <slug>（小寫英數）')
  process.exit(2)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const packDir = join(repoRoot, 'soul/packs', slug)

const REQUIRED_FILES = [
  'pack.json',
  'manifest.json',
  'constitution.md',
  'persona.md',
  'voice-dna.md',
  'speaking-style.md',
  'reaction-engine.md',
  'self-check.md',
  'my-existence.md',
  'growth-framework.md',
  'family-bridge.md',
  'skills/scheduling.md',
  'skills/promises.md',
  'skills/image-creation.md',
  'skills/reading-together.md',
  'skills/voice-clips.md',
  'skills/web-search.md',
  'skills/document-reading.md',
  'skills/aieq-assessment.md',
  'skills/mantou-emotional-voice/SKILL.md',
]

// 平台底線（不是角色個性，任何角色不得刪改）：檔案 → 必須出現的字串
const BOTTOM_LINES: [string, string[]][] = [
  ['reaction-engine.md', ['1925', '1980', '危機']],           // 危機閘門與轉介資源
  ['persona.md', ['禁語', '記憶誠實']],                        // 禁語清單＋不編造記憶
  ['self-check.md', ['自我檢查']],                             // 後設覺察
  ['skills/scheduling.md', ['[SCHEDULE']],                     // 標籤鐵律
  ['skills/promises.md', ['[REMIND']],
  ['skills/reading-together.md', ['[NOTE']],
  ['skills/aieq-assessment.md', ['不自行加權', '非心理診斷', '三種獨立同意']],
]

// PII 掃描（同通話包洗淨那套）
const PII_RE =
  /安咪|安媽咪|吳安安|育潼|威廉|威廷|蔡智堯|羅美宜|jennifer|waitin|windhunter|容容(?!易)|U[0-9a-f]{32}|sk-[A-Za-z0-9_-]{10,}|AKIA[A-Z0-9]{16}|sslip\.io|[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?![\d.])/i

const FALSE_POSITIVES = [/安安靜靜/]
const OLD_RUNTIME_IDENTITY = /你是慢慢|慢慢的(?:記憶|第一人稱|承諾)|慢慢(?:答|回)|漫漫帶讀/

async function main(): Promise<void> {
  let failed = 0
  const fail = (msg: string) => {
    failed++
    console.error(`  ❌ ${msg}`)
  }
  const ok = (msg: string) => console.log(`  ✅ ${msg}`)

  console.log(`— lint soul pack: ${slug} —`)

  // 1. 完整性
  for (const f of REQUIRED_FILES) {
    try {
      const content = await readFile(join(packDir, f), 'utf8')
      if (content.trim().length < 20) fail(`${f} 內容過短（<20 字）`)
    } catch {
      fail(`缺必備檔：${f}`)
    }
  }
  if (!failed) ok(`完整性：${REQUIRED_FILES.length} 個必備檔齊全`)

  // pack.json 欄位
  try {
    const pack = JSON.parse(await readFile(join(packDir, 'pack.json'), 'utf8')) as Record<string, unknown>
    for (const key of ['slug', 'name', 'tagline']) {
      if (!pack[key]) fail(`pack.json 缺欄位：${key}`)
    }
    if (pack.slug !== slug) fail(`pack.json slug（${pack.slug}）≠ 目錄名（${slug}）`)
  } catch (e) {
    fail(`pack.json 讀取/解析失敗：${(e as Error).message}`)
  }

  // 2. 平台底線
  for (const [file, needles] of BOTTOM_LINES) {
    try {
      const content = await readFile(join(packDir, file), 'utf8')
      for (const needle of needles) {
        if (!content.includes(needle)) fail(`平台底線被刪改：${file} 缺「${needle}」`)
      }
    } catch {
      // 缺檔已在完整性報過
    }
  }
  if (!failed) ok('平台底線：危機閘門／禁語／記憶誠實／標籤鐵律 全在')

  // 3. PII 掃描（全 pack 遞迴）
  async function scanDir(dir: string, rel = ''): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      const r = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) await scanDir(p, r)
      else if (/\.(md|json|txt)$/.test(entry.name)) {
        const content = await readFile(p, 'utf8')
        for (const line of content.split('\n')) {
          const approvedExistenceDisclosure = r === 'my-existence.md' && /威廷|Waitin/i.test(line)
          const generatedManifestMetadata = r === 'manifest.json'
          if (PII_RE.test(line) && !approvedExistenceDisclosure && !generatedManifestMetadata && !FALSE_POSITIVES.some((fp) => fp.test(line))) {
            fail(`PII 命中：${r} → ${line.trim().slice(0, 60)}`)
          }
        }
      }
    }
  }
  await scanDir(packDir)
  if (!failed) ok('PII 掃描：零命中')

  // 4. Runtime prompt identity regression guard. Natural phrases such as
  // 「慢慢來」are valid Chinese and intentionally not banned.
  const runtimeRoot = join(repoRoot, 'packages/backend/src')
  async function scanRuntime(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'migrations') await scanRuntime(path)
      } else if (/\.(ts|md)$/.test(entry.name)) {
        const content = await readFile(path, 'utf8')
        if (OLD_RUNTIME_IDENTITY.test(content)) {
          fail(`執行中提示詞含舊人格稱呼：${path.slice(runtimeRoot.length + 1)}`)
        }
      }
    }
  }
  await scanRuntime(runtimeRoot)
  if (!failed) ok('執行中提示詞：無「慢慢／漫漫」舊人格稱呼')

  console.log(failed ? `\n═══ lint 失敗：${failed} 項 ═══` : `\n═══ lint 通過：${slug} 可入 characters 表 ═══`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('lint crashed:', e)
  process.exit(2)
})
