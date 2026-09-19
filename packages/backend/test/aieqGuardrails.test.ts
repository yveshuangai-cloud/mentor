import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import vm from 'node:vm'
import { AIEQ_ANIMALS, AIEQ_QUESTIONS } from '../src/modules/aieq/index.js'

const publicDir = resolve(import.meta.dirname, '../public')
const assetsDir = resolve(import.meta.dirname, '../../../assets/aieq')

describe('AI Personality scoring contract', () => {
  // Copy may be rewritten freely. Question ids, option ids, order, dimensions and evidence weights may not:
  // changing any of them silently re-scores every stored answer. Update this table only with a product decision.
  // Freezes the live bank (ai-personality-2.0-8q). Weights come from the original classification
  // spec; q07 and q08 were eased off 1.00 on the planner's instruction so same-axis pairs cannot cancel.
  it('keeps question ids, option ids, order and evidence weights frozen', () => {
    const contract = AIEQ_QUESTIONS.map((question) => [
      question.id,
      question.dimensions,
      question.options.map((option) => [option.id, option.evidence]),
    ])
    expect(contract).toEqual([
      ['q01_new_tool', ['input'], [['experiment', { input: 0.7, transition_speed: 1, ambiguity_tolerance: 0.7, agency: 0.8 }], ['manual', { input: -0.8, transition_speed: -0.25, ambiguity_tolerance: -0.5, continuous_learning: 0.5 }], ['goal', { input: -0.2, ai_collaboration: 0.6, verification: 0.6, agency: 0.35 }]]],
      ['q02_ai_output', ['decide'], [['verify', { decide: -0.8, verification: 1, agency: 0.55 }], ['review', { decide: 0.7, verification: 0.75, ai_collaboration: 0.8 }], ['submit', { decide: -0.1, verification: -1, agency: -0.35 }]]],
      ['q03_team_trial', ['energy'], [['gather', { energy: -1, ai_collaboration: 1, agency: 0.8 }], ['prototype', { energy: 1, ai_collaboration: 0.25, agency: 0.9 }], ['clarify', { energy: -0.35, ai_collaboration: 0.85, verification: 0.4 }]]],
      ['q04_plan_breaks', ['action'], [['replan', { action: -1, transition_speed: 0.65, ambiguity_tolerance: -0.25, agency: 0.7 }], ['alternatives', { action: 1, transition_speed: 1, ambiguity_tolerance: 0.9 }], ['hold', { action: -0.15, transition_speed: -0.9, ambiguity_tolerance: -0.8, agency: -0.7 }]]],
      ['q05_failed_automation', ['input'], [['debug', { input: -1, verification: 1, continuous_learning: 0.7 }], ['rethink', { input: 1, transition_speed: 0.6, ambiguity_tolerance: 0.6, continuous_learning: 0.55 }], ['revert', { input: -0.35, transition_speed: -0.55, continuous_learning: -0.8 }]]],
      ['q06_team_disagrees', ['decide'], [['feelings', { decide: 1, ai_collaboration: 1, verification: 0.3 }], ['standard', { decide: -1, ai_collaboration: 0.65, verification: 1 }], ['escalate', { decide: -0.25, ai_collaboration: -0.3, agency: -0.35 }]]],
      ['q07_learning', ['energy'], [['squad', { energy: -0.8, continuous_learning: 0.9, ai_collaboration: 1, agency: 0.55 }], ['notes', { energy: 0.85, continuous_learning: 1, agency: 0.8 }], ['course', { energy: 0.1, continuous_learning: -0.8, agency: -0.75 }]]],
      ['q08_vague_request', ['action'], [['scope', { action: -0.85, ambiguity_tolerance: -0.25, agency: 0.65, verification: 0.5 }], ['draft', { action: 0.8, ambiguity_tolerance: 1, agency: 1, transition_speed: 0.75 }], ['defer', { action: -0.25, ambiguity_tolerance: -0.85, agency: -1 }]]],
    ])
  })

  it('keeps option copy usable as LINE Flex buttons and as a two-line LIFF choice', () => {
    for (const question of AIEQ_QUESTIONS) {
      const headlines = question.options.map((option) => option.shortLabel)
      expect(new Set(headlines).size, `${question.id} headlines must differ`).toBe(3)
      for (const option of question.options) {
        // LINE rejects Flex button labels longer than 40 characters.
        expect([...option.shortLabel].length, `${question.id}/${option.id} headline`).toBeLessThanOrEqual(40)
        // A headline past 14 characters wraps to a second line at 375px, which pushes option C off the
        // first screen. The association asked for all three to be visible without scrolling.
        expect([...option.shortLabel].length, `${question.id}/${option.id} wraps on a 375px screen`).toBeLessThanOrEqual(14)
        expect(option.label, `${question.id}/${option.id} detail must add information`).not.toBe(option.shortLabel)
      }
    }
  })
})

describe('AI Personality share card content', () => {
  // 2026-09-19 product decision: the four-letter shorthand stays because people read results by it,
  // the trademark never appears, and the animal and its trait lead the card.
  it('gives all 16 types a shorthand, a subtitle and a 自然優勢 line, with no trademark anywhere', () => {
    for (const animal of Object.values(AIEQ_ANIMALS)) {
      expect(animal.displayCode, animal.name).toMatch(/^[EI][SN][TF][JP]$/)
      expect([...animal.tagline].length, `${animal.name} 副標`).toBeGreaterThanOrEqual(8)
      expect([...animal.edge].length, `${animal.name} 自然優勢`).toBeGreaterThanOrEqual(8)
      for (const field of [animal.name, animal.title, animal.tagline, animal.edge]) {
        expect(field, animal.name).not.toMatch(/MBTI|Myers/i)
      }
    }
    const codes = Object.values(AIEQ_ANIMALS).map((animal) => animal.displayCode)
    expect(new Set(codes).size).toBe(16)
  })
})

describe('AI Personality artwork', () => {
  it('serves every scene, share card and animal as an existing JPEG', () => {
    const root = resolve(import.meta.dirname, '../../..')
    const toFile = (url: string) => url
      .replace('/aieq/assets/', 'assets/aieq/')
      .replace('/aieq/scenes/', 'assets/ai-personality/scenes/')
      .replace('/aieq/design/', 'output/design/')
    for (const animal of Object.values(AIEQ_ANIMALS)) {
      for (const url of [animal.imagePath, animal.resultScenePath, animal.shareCardPath]) {
        expect(url, animal.code).toMatch(/\.jpg$/)
        expect(existsSync(resolve(root, toFile(url))), url).toBe(true)
      }
    }
  })
})

describe('AI Personality persona copy', () => {
  it('gives all 16 types a full plain-language reading', () => {
    expect(Object.keys(AIEQ_ANIMALS)).toHaveLength(16)
    for (const animal of Object.values(AIEQ_ANIMALS)) {
      for (const field of ['strength', 'blindSpot', 'growthRoute'] as const) {
        expect([...animal[field]].length, `${animal.code}.${field} is still a short consultant phrase`).toBeGreaterThanOrEqual(25)
      }
      expect(animal.strength, `${animal.code}.strength should speak to the player`).toContain('你')
    }
  })
})

describe('AI Personality PWA shell', () => {
  const manifest = JSON.parse(readFileSync(resolve(publicDir, 'aieq-manifest.webmanifest'), 'utf8')) as {
    scope: string
    start_url: string
    icons: Array<{ src: string; sizes: string; type: string; purpose: string }>
  }

  it('scopes the installed app to /aieq only', () => {
    expect(manifest.scope).toBe('/aieq')
    expect(manifest.start_url.startsWith('/aieq')).toBe(true)
  })

  it('declares icons that exist and match their real pixel size', () => {
    expect(manifest.icons.some((icon) => icon.sizes === '192x192')).toBe(true)
    expect(manifest.icons.some((icon) => icon.sizes === '512x512' && icon.purpose === 'maskable')).toBe(true)
    for (const icon of manifest.icons) {
      const file = resolve(assetsDir, icon.src.replace('/aieq/assets/', ''))
      expect(existsSync(file), icon.src).toBe(true)
      if (icon.type !== 'image/png') continue
      const png = readFileSync(file)
      expect(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.src).toBe(icon.sizes)
    }
  })

  it('only lets the service worker handle AI Personality GET requests', () => {
    const handlers: Record<string, (event: unknown) => void> = {}
    const context = vm.createContext({
      URL,
      Response,
      caches: { open: async () => ({ put: async () => {}, addAll: async () => {} }), match: async () => undefined, keys: async () => [] },
      fetch: async () => new Response('ok'),
      self: {
        location: { origin: 'https://example.test' },
        addEventListener: (name: string, handler: (event: unknown) => void) => { handlers[name] = handler },
        skipWaiting: () => {},
        clients: { claim: () => {} },
      },
    })
    vm.runInContext(readFileSync(resolve(publicDir, 'aieq-sw.js'), 'utf8'), context)

    const handled = (url: string, method = 'GET') => {
      let responded = false
      handlers.fetch({ request: { url, method, mode: 'navigate' }, respondWith: (response: Promise<unknown>) => { responded = true; void response.catch(() => {}) } })
      return responded
    }
    expect(handled('https://example.test/aieq')).toBe(true)
    expect(handled('https://example.test/aieq?v=replay-1')).toBe(true)
    expect(handled('https://example.test/aieq/scenes/start/start-exploration-v1.png')).toBe(true)
    expect(handled('https://example.test/admin')).toBe(false)
    expect(handled('https://example.test/api/aieq/entry')).toBe(false)
    expect(handled('https://example.test/aieq', 'POST')).toBe(false)
    expect(handled('https://static.line-scdn.net/liff/edge/2/sdk.js')).toBe(false)
  })
})
