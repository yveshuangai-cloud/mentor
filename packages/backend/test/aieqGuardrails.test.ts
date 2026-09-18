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
  it('keeps question ids, option ids, order and evidence weights frozen', () => {
    const contract = AIEQ_QUESTIONS.map((question) => [
      question.id,
      question.dimensions,
      question.options.map((option) => [option.id, option.evidence]),
    ])
    expect(contract).toEqual([
      ['q01_ai_trend', ['EI'], [['try', { EI: -0.5 }], ['natural', { EI: -0.125 }], ['observe', { EI: 0.5 }]]],
      ['q02_ai_copy', ['SN'], [['angle', { SN: 3 }], ['feeling', { SN: -0.75 }], ['logic', { SN: -3 }]]],
      ['q03_ai_image', ['SN'], [['scroll', { SN: -0.5 }], ['story', { SN: 2 }], ['flaw', { SN: -2 }]]],
      ['q04_ai_blocked', ['TF'], [['disappointed', { TF: 3 }], ['retry', { TF: -3 }], ['switch', { TF: -0.75 }]]],
      ['q05_ai_slides', ['TF'], [['usable', { TF: -0.5 }], ['warmth', { TF: 2 }], ['error', { TF: -2 }]]],
      ['q06_ai_learning', ['EI'], [['docs', { EI: 2.5 }], ['wait', { EI: -0.25 }], ['discuss', { EI: -2.5 }]]],
      ['q07_ai_habit', ['JP'], [['spontaneous', { JP: 2 }], ['forget', { JP: -0.5 }], ['template', { JP: -2 }]]],
      ['q08_ai_options', ['JP'], [['pick', { JP: -3 }], ['more', { JP: 3 }], ['stash', { JP: -0.75 }]]],
    ])
  })

  it('keeps option copy usable as LINE Flex buttons and as a two-line LIFF choice', () => {
    for (const question of AIEQ_QUESTIONS) {
      const headlines = question.options.map((option) => option.shortLabel)
      expect(new Set(headlines).size, `${question.id} headlines must differ`).toBe(3)
      for (const option of question.options) {
        // LINE rejects Flex button labels longer than 40 characters.
        expect([...option.shortLabel].length, `${question.id}/${option.id} headline`).toBeLessThanOrEqual(40)
        expect(option.label, `${question.id}/${option.id} detail must add information`).not.toBe(option.shortLabel)
      }
    }
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
