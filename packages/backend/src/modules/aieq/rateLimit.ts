/**
 * Small in-memory sliding-window limiter for the AIEQ routes. Per process, which is
 * enough for one Railway instance; a shared store can replace it without touching callers.
 */
const buckets = new Map<string, number[]>()
let lastPrune = 0

export function allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  if (now - lastPrune > 60_000) prune(now)
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs)
  if (hits.length >= limit) { buckets.set(key, hits); return false }
  hits.push(now)
  buckets.set(key, hits)
  return true
}

function prune(now: number): void {
  lastPrune = now
  for (const [key, hits] of buckets) {
    const keep = hits.filter((t) => now - t < 3_600_000)
    if (keep.length) buckets.set(key, keep)
    else buckets.delete(key)
  }
}

export function resetRateLimits(): void {
  buckets.clear()
  lastPrune = 0
}
