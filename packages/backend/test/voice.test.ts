import { describe, expect, it } from 'vitest'
import { ensurePreferredVoice, extractVoiceTags } from '../src/modules/voice.js'

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

  it('removes AI-looking Markdown before sending text to TTS', () => {
    const result = extractVoiceTags('[VOICE_GEN|**先看問題。** -- 再慢慢處理。]')

    expect(result.clips[0]?.text).toBe('先看問題。再慢慢處理。')
  })
})

describe('ensurePreferredVoice', () => {
  it('adds a short voice clip when an audio reply omitted the control tag', () => {
    const result = ensurePreferredVoice('我聽懂了。這件事我們可以慢慢拆開處理。後面還有比較長的文字說明。')
    expect(result).toContain('[VOICE_GEN|')
    expect(extractVoiceTags(result).clips[0]?.text.length).toBeLessThanOrEqual(260)
    expect(extractVoiceTags(result).cleanText).toBe('')
  })

  it('does not duplicate an existing voice clip', () => {
    const reply = '文字補充。\n[VOICE_GEN|我用聲音回你。]'
    expect(ensurePreferredVoice(reply)).toBe(reply)
  })

  it('does not speak URLs', () => {
    const result = ensurePreferredVoice('你可以看 https://example.com/details 。我再陪你確認。')
    expect(result).not.toMatch(/VOICE_GEN[^\]]*https:/)
  })
})
