import { beforeEach, describe, expect, it } from 'vitest'
import { allow, resetRateLimits } from '../src/modules/aieq/rateLimit.js'

describe('AIEQ rate limiter', () => {
  beforeEach(() => resetRateLimits())

  it('allows up to the limit inside the window and refuses the next call', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) expect(allow('k', 5, 60_000, t0 + i)).toBe(true)
    expect(allow('k', 5, 60_000, t0 + 10)).toBe(false)
  })

  it('forgets hits once they fall out of the window', () => {
    const t0 = 1_000_000
    for (let i = 0; i < 5; i++) allow('k', 5, 60_000, t0)
    expect(allow('k', 5, 60_000, t0 + 59_000)).toBe(false)
    expect(allow('k', 5, 60_000, t0 + 60_001)).toBe(true)
  })

  it('keeps keys independent', () => {
    for (let i = 0; i < 3; i++) allow('a', 3, 60_000, 1)
    expect(allow('a', 3, 60_000, 2)).toBe(false)
    expect(allow('b', 3, 60_000, 2)).toBe(true)
  })
})
