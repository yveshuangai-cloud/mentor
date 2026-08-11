import { createHash, randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { platformQuery, pool } from '../src/db/index.js'
import {
  buildAnonymizedReplay,
  directIdentifierLeaks,
  type ReplaySourceConversation,
} from '../src/modules/turnKernel/replay.js'

function arg(name: string): string | undefined {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length)
}

const limit = Math.min(10_000, Math.max(1, Number(arg('limit') ?? 2_000)))
const perChannel = Math.min(500, Math.max(1, Number(arg('per-channel') ?? 100)))
const output = resolve(arg('output') ?? `tmp/replays/mantou-${new Date().toISOString().slice(0, 10)}.jsonl`)
const secret = process.env.REPLAY_ANONYMIZATION_SECRET || arg('secret') || randomBytes(32).toString('hex')

try {
  const rows = await platformQuery<ReplaySourceConversation>(
    `SELECT id, tenant_id, user_id, message_type, user_message, ai_response, metadata, created_at
     FROM conversations
     WHERE user_message IS NOT NULL AND ai_response IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit],
  )
  const cases = buildAnonymizedReplay(rows.rows, secret, perChannel)
  const body = cases.map((item) => JSON.stringify(item)).join('\n') + (cases.length ? '\n' : '')
  const leaks = directIdentifierLeaks(body)
  if (leaks.length) throw new Error(`Replay export refused: direct identifiers remain (${leaks.join(', ')})`)
  await mkdir(dirname(output), { recursive: true })
  await writeFile(output, body, 'utf8')
  const actorChannels = new Map<string, Set<string>>()
  for (const item of cases) {
    const channels = actorChannels.get(item.actor) ?? new Set<string>()
    channels.add(item.channel)
    actorChannels.set(item.actor, channels)
  }
  const crossChannelActors = new Set(
    [...actorChannels].filter(([, channels]) => channels.size >= 2).map(([actor]) => actor),
  )
  const crossChannelCases = cases.filter((item) => crossChannelActors.has(item.actor))
  const crossChannelOutput = output.replace(/\.jsonl$/i, '') + '.cross-channel.jsonl'
  const crossChannelBody = crossChannelCases.map((item) => JSON.stringify(item)).join('\n')
    + (crossChannelCases.length ? '\n' : '')
  await writeFile(crossChannelOutput, crossChannelBody, 'utf8')
  const counts = Object.fromEntries(
    [...new Set(cases.map((item) => item.channel))].map((channel) => [
      channel,
      cases.filter((item) => item.channel === channel).length,
    ]),
  )
  const manifest = {
    version: '1.0',
    generatedAt: new Date().toISOString(),
    sourceRows: rows.rowCount,
    cases: cases.length,
    actors: new Set(cases.map((item) => item.actor)).size,
    crossChannelActors: crossChannelActors.size,
    crossChannelCases: crossChannelCases.length,
    channels: counts,
    sha256: createHash('sha256').update(body).digest('hex'),
    output,
    crossChannelOutput,
    note: 'Exact timestamps and database identifiers are excluded. Names in free text require human privacy review.',
  }
  await writeFile(`${output}.manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.info(JSON.stringify(manifest, null, 2))
} finally {
  await pool.end()
}
