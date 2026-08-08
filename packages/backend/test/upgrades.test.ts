import { describe, expect, it } from 'vitest'
import { parseUpgradeRequestTag, stripUpgradeRequestTags } from '../src/modules/upgrades.js'

describe('upgrade request tags', () => {
  it('extracts an authorized upgrade request without exposing the control tag', () => {
    const reply = '好，我先把睡覺功能關掉。\n[UPGRADE_REQUEST title="關閉睡覺" details="饅頭不需要睡覺或做夢"]'
    expect(parseUpgradeRequestTag(reply)).toEqual({
      title: '關閉睡覺',
      details: '饅頭不需要睡覺或做夢',
    })
    expect(stripUpgradeRequestTags(reply)).toBe('好，我先把睡覺功能關掉。')
  })

  it('ignores malformed tags', () => {
    expect(parseUpgradeRequestTag('[UPGRADE_REQUEST details="沒有標題"]')).toBeNull()
  })
})
