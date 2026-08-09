import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..')
const packDir = join(repoRoot, 'soul/packs/mantou')
const files = [
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
  'skills/mantou-emotional-voice/SKILL.md',
]

const hash = (content: string) => createHash('sha256').update(content, 'utf8').digest('hex')
const contents = await Promise.all(files.map((file) => readFile(join(packDir, file), 'utf8')))
const manifest = {
  schema_version: 1,
  pack: 'mantou',
  version: '2026.08.09.2',
  hash_algorithm: 'sha256',
  generated_at: '2026-08-09T00:00:00.000Z',
  files: Object.fromEntries(files.map((file, index) => [file, hash(contents[index])])),
}

const master = [
  '# 饅頭（Mentor）核心提示詞母版',
  '',
  `版本：${manifest.version}`,
  `Manifest：soul/packs/mantou/manifest.json`,
  '',
  '> 此檔由已驗證的執行中 soul pack 組合而成；執行時仍由 manifest 指定的分檔載入。請勿直接手改此檔後期待執行環境生效。',
  '',
  ...files.flatMap((file, index) => [`## ${file}`, '', contents[index].trim(), '']),
].join('\n')

await writeFile(join(packDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await writeFile(join(repoRoot, '饅頭(Mentor) 提示詞.md'), master, 'utf8')
console.log(`wrote manifest (${files.length} files) and canonical master (${master.length} chars)`)
