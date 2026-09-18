import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'

const publicDir = resolve(import.meta.dirname, '../public')

// The core file is plain browser JS; run it in a bare vm so any DOM or network dependency fails loudly here.
function loadCore() {
  const context = vm.createContext({ URL, URLSearchParams })
  vm.runInContext(readFileSync(resolve(publicDir, 'aieq-core.js'), 'utf8'), context)
  return context.AieqCore as Record<string, (...args: any[]) => any>
}
const core = loadCore()

describe('LIFF pure helpers (aieq-core.js)', () => {
  it('escapes everything that could break out of markup', () => {
    expect(core.safe(`<img src=x onerror="alert('x')">&`)).toBe('&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;')
    expect(core.safe(null)).toBe('')
    expect(core.safe(42)).toBe('42')
  })

  it('trims nicknames to 14 characters by code point, not by UTF-16 unit', () => {
    expect(core.truncateName('  WaitinChen 陳威廷  ')).toBe('WaitinChen 陳威廷')
    expect(core.truncateName('😀'.repeat(20))).toBe('😀'.repeat(14))
    expect(core.truncateName(undefined)).toBe('')
  })

  it('describes a tendency honestly according to evidence and strength', () => {
    const at = (strength: number, evidenceCount = 2, preference = 'E') => core.tendency({ strength, evidenceCount, preference })
    expect(at(100)).toBe('很明顯偏 E')
    expect(at(67)).toBe('很明顯偏 E')
    expect(at(50)).toBe('比較偏 E')
    expect(at(20)).toBe('兩邊都像，稍微偏 E')
    expect(at(100, 1, 'P')).toBe('這次偏 P（只有一題，僅供參考）')
    expect(at(100, 0, 'X')).toBe('這次沒有足夠的作答可以判斷')
    expect(at(100, 2, '<b>')).toBe('很明顯偏 &lt;b&gt;')
  })

  it('draws the radar collapsed at the centre with targets that stay inside the chart', () => {
    const axes = [{ strength: 100, preference: 'E' }, { strength: 50, preference: 'S' }, { strength: 0, preference: 'T' }, { strength: 20, preference: 'J' }]
    const svg = core.radarChart(axes) as string
    expect(svg).toContain('points="160,150 160,150 160,150 160,150"')
    const target = /data-target="([^"]+)"/.exec(svg)![1].split(' ').map((p) => p.split(',').map(Number))
    expect(target).toHaveLength(4)
    expect(target[0]).toEqual([160, 46])          // 100% up the vertical axis (cy 150 - max 104)
    expect(target[2]).toEqual([160, 172])         // 0% still sits min 22 below the centre so the shape never vanishes
    for (const [x, y] of target) { expect(x).toBeGreaterThanOrEqual(56); expect(x).toBeLessThanOrEqual(264); expect(y).toBeGreaterThanOrEqual(46); expect(y).toBeLessThanOrEqual(254) }
    expect((svg.match(/<circle class="radar-dot" cx="160" cy="150"/g) ?? []).length).toBe(4)
    expect(svg).toContain('E · 能量來源')
    expect(svg).toContain('J · 行動方式')
  })

  it('reads an invite token from a direct link and from a LIFF-wrapped link', () => {
    expect(core.inviteFromUrl('?invite=abc123', 'https://x.test')).toBe('abc123')
    expect(core.inviteFromUrl('?liff.state=%3Finvite%3Dabc123', 'https://x.test')).toBe('abc123')
    expect(core.inviteFromUrl('?liff.state=%2Faieq%3Finvite%3Dxyz', 'https://x.test')).toBe('xyz')
    expect(core.inviteFromUrl('', 'https://x.test')).toBeNull()
  })

  it('turns invite error codes into plain Chinese and never hides an unknown one', () => {
    expect(core.inviteErrorMessage('cannot_friend_self')).toMatch(/自己發出的邀請/)
    expect(core.inviteErrorMessage('invite_invalid_or_expired')).toMatch(/過期或無效/)
    expect(core.inviteErrorMessage('invite_already_claimed')).toMatch(/另一位朋友使用/)
    expect(core.inviteErrorMessage('boom')).toBe('邀請無法使用：boom')
  })

  it('offers the add-friend card only when an OA is configured and the player is not a friend yet', () => {
    expect(core.shouldOfferAddFriend('@abc', null)).toBe(true)
    expect(core.shouldOfferAddFriend('@abc', false)).toBe(true)
    expect(core.shouldOfferAddFriend('@abc', true)).toBe(false)
    expect(core.shouldOfferAddFriend('', null)).toBe(false)
    expect(core.isValidOaBasicId('@740bicby')).toBe(true)
    expect(core.isValidOaBasicId('740bicby')).toBe(false)
    expect(core.isValidOaBasicId('@a')).toBe(false)
  })
})

describe('LIFF page structure', () => {
  const html = readFileSync(resolve(publicDir, 'aieq.html'), 'utf8')
  const main = readFileSync(resolve(publicDir, 'aieq.js'), 'utf8')

  it('keeps markup, styles and scripts in separate files', () => {
    expect(html).not.toMatch(/<style>/)
    expect(html).not.toMatch(/<script>/)
    expect(html).toContain('/aieq.css?v=__ASSET_V__')
    expect(html).toContain('/aieq-core.js?v=__ASSET_V__')
    expect(html).toContain('/aieq.js?v=__ASSET_V__')
    expect(html.indexOf('aieq-core.js')).toBeLessThan(html.indexOf('/aieq.js?'))
  })

  it('only pulls helpers that the core actually exports', () => {
    const pulled = /const \{([^}]+)\}=AieqCore/.exec(main)![1].split(',').map((s) => s.trim())
    for (const name of pulled) expect(typeof core[name], name).toBe('function')
    for (const name of Object.keys(core)) expect(pulled, `${name} is exported but unused`).toContain(name)
  })
})
