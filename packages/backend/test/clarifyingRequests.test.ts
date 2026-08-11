import { describe, expect, it } from 'vitest'
import { loadCharacterCore } from '../src/modules/soul/loader.js'

describe('Mantou clarification skill', () => {
  it('loads the ambiguous-request decision rules into the runtime soul prompt', async () => {
    const soul = await loadCharacterCore('mantou')

    expect(soul.skills).toContain('模糊指令的釐清能力')
    expect(soul.skills).toContain('提供三個互斥選項')
    expect(soul.skills).toContain('低風險、可逆的小細節')
  })
})
