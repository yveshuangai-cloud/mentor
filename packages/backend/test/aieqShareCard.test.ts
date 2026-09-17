import { describe, expect, it } from 'vitest'
import { AIEQ_ANIMALS, buildShareInviteFlex } from '../src/modules/aieq/index.js'

const base = {
  typeCode: 'ENFP',
  inviteUrl: 'https://liff.line.me/1655082627-iMevj93k?invite=abc',
  publicBaseUrl: 'https://staging.example',
}
const flat = (node: unknown): Array<Record<string, unknown>> => {
  if (!node || typeof node !== 'object') return []
  const self = node as Record<string, unknown>
  return [self, ...Object.values(self).flatMap((value) => Array.isArray(value) ? value.flatMap(flat) : flat(value))]
}

describe('AI Personality share card (LINE Flex)', () => {
  it('shows the player, their type card and one clear call to action', () => {
    const message = buildShareInviteFlex({ ...base, displayName: 'WaitinChen', pictureUrl: 'https://profile.line-scdn.net/abc' })
    expect(message.type).toBe('flex')
    expect(message.altText).toBe('WaitinChen 的 AI 人格是 ENFP 水獺，你也來測測看')
    const nodes = flat(message.contents)
    const images = nodes.filter((node) => node.type === 'image').map((node) => node.url)
    expect(images).toEqual([`https://staging.example${AIEQ_ANIMALS.ENFP.shareCardPath}`, 'https://profile.line-scdn.net/abc'])
    expect(nodes.some((node) => node.type === 'text' && node.text === 'WaitinChen')).toBe(true)
    const buttons = nodes.filter((node) => node.type === 'button')
    expect(buttons).toHaveLength(1)
    expect((buttons[0].action as { uri: string }).uri).toBe(base.inviteUrl)
  })

  it('always covers the placeholder portrait that is drawn into the card art', () => {
    for (const pictureUrl of ['https://profile.line-scdn.net/abc', 'http://insecure.example/a.png', null, undefined]) {
      const nodes = flat(buildShareInviteFlex({ ...base, displayName: '小雨', pictureUrl }).contents)
      const cover = nodes.find((node) => node.position === 'absolute' && node.cornerRadius)
      expect(cover, String(pictureUrl)).toMatchObject({ offsetTop: '11px', offsetStart: '196px', width: '101px', height: '101px', backgroundColor: '#050505' })
      // LINE rejects non-HTTPS images, so anything else falls back to the player's initial.
      const inner = (cover!.contents as Array<Record<string, unknown>>)[0]
      if (pictureUrl?.startsWith('https://')) expect(inner).toMatchObject({ type: 'image', url: pictureUrl })
      else expect(inner).toMatchObject({ type: 'text', text: '小' })
    }
  })

  it('stays inside LINE limits for every type and odd names', () => {
    for (const typeCode of Object.keys(AIEQ_ANIMALS)) {
      const message = buildShareInviteFlex({ ...base, typeCode, displayName: '  名字非常非常非常非常非常長的玩家😀😀😀  ', pictureUrl: null })
      expect([...message.altText].length, typeCode).toBeLessThanOrEqual(400)
      for (const node of flat(message.contents)) {
        if (node.type === 'button') expect([...(node.action as { label: string }).label].length).toBeLessThanOrEqual(40)
        if (node.type === 'image') expect(String(node.url)).toMatch(/^https:\/\//)
        if (node.type === 'text') expect(String(node.text).length).toBeGreaterThan(0)
      }
    }
    expect(buildShareInviteFlex({ ...base, displayName: '', pictureUrl: null }).altText.startsWith('我 的 AI 人格是')).toBe(true)
  })
})
