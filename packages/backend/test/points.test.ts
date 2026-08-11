import { beforeEach, describe, expect, it, vi } from 'vitest'

const { platformQuery, withTransaction } = vi.hoisted(() => ({
  platformQuery: vi.fn(),
  withTransaction: vi.fn(),
}))

vi.mock('../src/db/index.js', () => ({ platformQuery, withTransaction }))

import { chargeGate } from '../src/modules/points.js'

describe('closed-test point exemption', () => {
  beforeEach(() => {
    platformQuery.mockReset()
    withTransaction.mockReset()
  })

  it('never charges or enters the debit transaction for a soul-authorized turn', async () => {
    platformQuery.mockResolvedValue({ rows: [{ sum: '0' }] })

    await expect(chargeGate(7, 'web_search', { exempt: true })).resolves.toEqual({
      gate: 'web_search',
      cost: 0,
      balance: 0,
      charged: false,
    })
    expect(withTransaction).not.toHaveBeenCalled()
  })
})
