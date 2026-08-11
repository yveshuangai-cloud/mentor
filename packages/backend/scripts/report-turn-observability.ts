import { platformQuery, pool } from '../src/db/index.js'

interface EventRow {
  turn_id: string
  channel: string
  event_type: string
  elapsed_ms: number
  payload: Record<string, any>
  occurred_at: Date
}

function percentile(values: number[], ratio: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] ?? null
}

const daysArg = process.argv.find((value) => value.startsWith('--days='))?.slice(7)
const days = Math.min(90, Math.max(1, Number(daysArg ?? 7)))

try {
  const result = await platformQuery<EventRow>(
    `SELECT turn_id, channel, event_type, elapsed_ms, payload, occurred_at
     FROM turn_events
     WHERE occurred_at >= now() - ($1::text || ' days')::interval
     ORDER BY turn_id, elapsed_ms`,
    [days],
  )
  const byTurn = new Map<string, EventRow[]>()
  for (const row of result.rows) {
    const events = byTurn.get(row.turn_id) ?? []
    events.push(row)
    byTurn.set(row.turn_id, events)
  }

  const stageMs = new Map<string, number[]>()
  const tokensIn: number[] = []
  const tokensOut: number[] = []
  const estimatedContextTokens: number[] = []
  const blockStats = new Map<string, { turns: number; estimatedTokens: number; loadMs: number[]; observedUse: number }>()
  const channelCounts = new Map<string, number>()

  for (const events of byTurn.values()) {
    channelCounts.set(events[0]!.channel, (channelCounts.get(events[0]!.channel) ?? 0) + 1)
    for (let index = 1; index < events.length; index += 1) {
      const name = `${events[index - 1]!.event_type} -> ${events[index]!.event_type}`
      const values = stageMs.get(name) ?? []
      values.push(Math.max(0, events[index]!.elapsed_ms - events[index - 1]!.elapsed_ms))
      stageMs.set(name, values)
    }
    const context = events.find((event) => event.event_type === 'context.compiled')?.payload
    const model = events.find((event) => event.event_type === 'model.completed')?.payload
    if (typeof context?.estimatedTokens === 'number') estimatedContextTokens.push(context.estimatedTokens)
    if (typeof model?.tokensInput === 'number') tokensIn.push(model.tokensInput)
    if (typeof model?.tokensOutput === 'number') tokensOut.push(model.tokensOutput)
    const evidence = new Map<string, boolean>(
      (model?.contextUseEvidence ?? []).map((item: any) => [item.name, Boolean(item.observed)]),
    )
    for (const block of context?.blocks ?? []) {
      const stats = blockStats.get(block.name) ?? { turns: 0, estimatedTokens: 0, loadMs: [], observedUse: 0 }
      stats.turns += 1
      stats.estimatedTokens += Number(block.estimatedTokens ?? 0)
      if (typeof block.loadMs === 'number') stats.loadMs.push(block.loadMs)
      if (evidence.get(block.name)) stats.observedUse += 1
      blockStats.set(block.name, stats)
    }
  }

  console.info(JSON.stringify({
    windowDays: days,
    turns: byTurn.size,
    channels: Object.fromEntries(channelCounts),
    tokens: {
      inputP50: percentile(tokensIn, 0.5),
      inputP95: percentile(tokensIn, 0.95),
      outputP50: percentile(tokensOut, 0.5),
      contextEstimateP50: percentile(estimatedContextTokens, 0.5),
    },
    stageLatency: Object.fromEntries([...stageMs].map(([name, values]) => [name, {
      samples: values.length,
      p50Ms: percentile(values, 0.5),
      p95Ms: percentile(values, 0.95),
    }])),
    contextBlocks: Object.fromEntries([...blockStats].map(([name, stats]) => [name, {
      turns: stats.turns,
      avgEstimatedTokens: Math.round(stats.estimatedTokens / stats.turns),
      loadP50Ms: percentile(stats.loadMs, 0.5),
      observedUseRate: Number((stats.observedUse / stats.turns).toFixed(3)),
      useEvidence: 'citation_or_surface_overlap_proxy',
    }])),
  }, null, 2))
} finally {
  await pool.end()
}
