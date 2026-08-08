import { describe, expect, it } from 'vitest'
import { extractVoiceTags } from '../src/modules/voice.js'

describe('extractVoiceTags', () => {
  it('extracts the documented Mantou voice tag format', () => {
    const result = extractVoiceTags('先給文字。\n[VOICE_GEN|我聽見了，你先不用急著回答。]')

    expect(result.cleanText).toBe('先給文字。')
    expect(result.clips).toEqual([{ text: '我聽見了，你先不用急著回答。', emotion: undefined }])
  })

  it('extracts emotion without speaking the control marker', () => {
    const result = extractVoiceTags('[VOICE_GEN|（輕笑）這件事可以慢慢來。]')

    expect(result.cleanText).toBe('')
    expect(result.clips).toEqual([{ text: '這件事可以慢慢來。', emotion: 'happy' }])
  })
})
