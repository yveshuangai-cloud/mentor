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
    const at = (strength: number, evidenceCount = 2, poleName = '向外') => core.tendency({ strength, evidenceCount, poleName })
    expect(at(100)).toBe('很明顯偏 向外')
    expect(at(67)).toBe('很明顯偏 向外')
    expect(at(50)).toBe('比較偏 向外')
    expect(at(20)).toBe('兩邊都像，稍微偏 向外')
    expect(at(100, 1, '彈性')).toBe('這次偏 彈性（只有一題，僅供參考）')
    expect(at(100, 0, '還看不出來')).toBe('這次沒有足夠的作答可以判斷')
    expect(at(100, 2, '<b>')).toBe('很明顯偏 &lt;b&gt;')
  })

  it('gives every tendency a plain-language line instead of a bare label', async () => {
    const { scoreAssessment, createAieqSession, transitionAieqSession, AIEQ_QUESTIONS } =
      await import('../src/modules/aieq/index.js')
    let session = createAieqSession('blurb')
    AIEQ_QUESTIONS.forEach((question, index) => {
      session = transitionAieqSession(session, {
        eventId: `blurb-${index}`, sessionId: session.id, source: 'card', kind: 'answer',
        questionId: question.id, optionId: question.options[0].id,
        occurredAt: new Date(1_700_000_000_000 + index).toISOString(), interpretationConfidence: 1,
      }, AIEQ_QUESTIONS).session
    })
    for (const axis of Object.values(scoreAssessment(session, AIEQ_QUESTIONS).axes)) {
      expect([...axis.poleBlurb].length, `${axis.dimension} blurb`).toBeGreaterThanOrEqual(12)
      expect(axis.poleBlurb, `${axis.dimension} blurb`).not.toMatch(/[EISNTFJP] ?\/|MBTI/)
    }
  })

  it('draws the radar collapsed at the centre with targets that stay inside the chart', () => {
    const axes = [{ strength: 100, axisName: '能量來源' }, { strength: 50, axisName: '接收資訊' }, { strength: 0, axisName: '做決定' }, { strength: 20, axisName: '行動方式' }]
    const svg = core.radarChart(axes) as string
    expect(svg).toContain('points="160,150 160,150 160,150 160,150"')
    const target = /data-target="([^"]+)"/.exec(svg)![1].split(' ').map((p) => p.split(',').map(Number))
    expect(target).toHaveLength(4)
    expect(target[0]).toEqual([160, 46])          // 100% up the vertical axis (cy 150 - max 104)
    expect(target[2]).toEqual([160, 172])         // 0% still sits min 22 below the centre so the shape never vanishes
    for (const [x, y] of target) { expect(x).toBeGreaterThanOrEqual(56); expect(x).toBeLessThanOrEqual(264); expect(y).toBeGreaterThanOrEqual(46); expect(y).toBeLessThanOrEqual(254) }
    expect((svg.match(/<circle class="radar-dot" cx="160" cy="150"/g) ?? []).length).toBe(4)
    expect(svg).toContain('能量來源')
    expect(svg).toContain('行動方式')
    // No borrowed letters reach the chart.
    expect(svg).not.toMatch(/>[EISNTFJP] ·/)
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

describe('團隊回報小標籤 helpers (aieq-core.js)', () => {
  it('names every key screen in plain words', () => {
    const label = (spot: string) => /class="team-tag-spot">([^<]*)</.exec(core.teamTagHtml(spot))?.[1]
    expect(label('intro')).toBe('封面／開始頁')
    expect(label('question:q03_ai_image')).toBe('第 3 題')
    expect(label('question:q08_ai_options')).toBe('第 8 題')
    expect(label('result:radar')).toBe('雷達圖')
    expect(label('friends')).toBe('朋友圈頁')
    expect(label('something:new')).toBe('something:new')
  })

  it('renders the three verdict buttons and reflects what was already reported', () => {
    const fresh = core.teamTagHtml('result:story')
    expect(fresh).toContain('data-spot="result:story"')
    expect(fresh).toContain('團隊回報小標籤')
    for (const label of ['這裡規劃得很好', '這裡規劃有問題', '我有其他意見']) expect(fresh).toContain(label)
    expect(fresh).toContain('回報會連同你的 LINE 暱稱與頭像記給團隊')
    expect(fresh).not.toContain('class="active"')

    const mine = core.teamTagHtml('intro', { verdict: 'issue', comment: '<b>字太小</b>' })
    expect(mine).toContain('data-verdict="issue" class="active"')
    expect(mine).toContain('已記錄：這裡規劃有問題（&lt;b&gt;字太小&lt;/b&gt;）')
  })
})

