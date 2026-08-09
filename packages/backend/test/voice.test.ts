import { describe, expect, it } from 'vitest'
import {
  clampVoiceCallReply,
  ensurePreferredVoice,
  extractVoiceTags,
  MINIMAX_EMOTIONS,
  MINIMAX_INTERJECTION_TAGS,
  MINIMAX_TTS_MODEL,
  planVoiceCallSegments,
  resolveLiveVoiceProfile,
  resolveVoiceProfile,
} from '../src/modules/voice.js'

describe('extractVoiceTags', () => {
  it('extracts the documented Mantou voice tag format', () => {
    const result = extractVoiceTags('先給文字。\n[VOICE_GEN|我聽見了，你先不用急著回答。]')

    expect(result.cleanText).toBe('先給文字。')
    expect(result.clips).toEqual([{ text: '我聽見了，你先不用急著回答。', emotion: undefined, style: 'comfort' }])
  })

  it('extracts emotion without speaking the control marker', () => {
    const result = extractVoiceTags('[VOICE_GEN|（輕笑）這件事可以慢慢來。]')

    expect(result.cleanText).toBe('')
    expect(result.clips).toEqual([{ text: '(chuckle)這件事可以慢慢來。', emotion: 'happy', style: 'comfort' }])
  })

  it('removes AI-looking Markdown before sending text to TTS', () => {
    const result = extractVoiceTags('[VOICE_GEN|**先看問題。** -- 再慢慢處理。]')

    expect(result.clips[0]?.text).toBe('先看問題。再慢慢處理。')
  })

  it('supports Mantou explicit emotion and style attributes', () => {
    const result = extractVoiceTags('[VOICE_GEN emotion="calm" style="news"|這是今天人工智慧新聞的三個重點。]')

    expect(result.clips).toEqual([{
      text: '這是今天人工智慧新聞的三個重點。',
      emotion: 'calm',
      style: 'news',
    }])
  })

  it('converts native sound cues for MiniMax speech 2.8', () => {
    const result = extractVoiceTags('[VOICE_GEN|（嘆氣）先讓我陪你一下。（吸氣）我們再慢慢往前。]')

    expect(result.clips[0]?.text).toContain('(sighs)')
    expect(result.clips[0]?.text).toContain('(inhale)')
    expect(result.clips[0]?.emotion).toBe('sad')
  })

  it('supports all 19 documented MiniMax Speech 2.8 interjection tags', () => {
    expect(MINIMAX_INTERJECTION_TAGS).toHaveLength(19)
    const result = extractVoiceTags('[VOICE_GEN|（咳嗽）（清喉嚨）（呻吟）（喘氣）（抽鼻子）（哼鼻子）（打嗝）（咂嘴）（哼唱）（嘶聲）（嗯）（打噴嚏）測試。]')
    for (const tag of [
      'coughs', 'clear-throat', 'groans', 'pant', 'sniffs', 'snorts',
      'burps', 'lip-smacking', 'humming', 'hissing', 'emm', 'sneezes',
    ]) {
      expect(result.clips[0]?.text).toContain(`(${tag})`)
    }
  })

  it('splits a clear emotional turn into two voice clips', () => {
    const result = extractVoiceTags('[VOICE_GEN|我知道你今天真的很難過。可是我相信你一定做得到！]')

    expect(result.clips).toHaveLength(2)
    expect(result.clips[0]).toMatchObject({ emotion: 'sad', style: 'comfort' })
    expect(result.clips[1]).toMatchObject({ emotion: 'happy', style: 'encourage' })
  })
})

describe('resolveVoiceProfile', () => {
  it('uses a quicker automatic delivery for neutral news', () => {
    expect(resolveVoiceProfile({ text: '這是今天的 AI 新聞。' })).toMatchObject({
      emotion: undefined, style: 'news', speed: 1.05, pitch: 0,
    })
  })

  it('slows comfort and brightens encouragement', () => {
    expect(resolveVoiceProfile({ text: '我知道你很難過，我陪你。' })).toMatchObject({
      emotion: 'sad', style: 'comfort', speed: 0.9, pitch: -1,
    })
    expect(resolveVoiceProfile({ text: '你做得到，我們一起往前走。' })).toMatchObject({
      emotion: 'happy', style: 'encourage', speed: 1, pitch: 1,
    })
  })

  it('uses MiniMax speech 2.8 HD', () => {
    expect(MINIMAX_TTS_MODEL).toBe('speech-2.8-hd')
  })

  it('supports exactly the seven documented Speech 2.8 emotions', () => {
    expect(MINIMAX_EMOTIONS).toEqual([
      'happy', 'sad', 'angry', 'fearful', 'disgusted', 'surprised', 'calm',
    ])
  })

  it('selects strong emotions only when semantic evidence exists', () => {
    expect(resolveVoiceProfile({ text: '這件事太荒謬，我不能接受。' }).emotion).toBe('angry')
    expect(resolveVoiceProfile({ text: '我真的很害怕，也擔心會有危險。' }).emotion).toBe('fearful')
    expect(resolveVoiceProfile({ text: '這種做法讓人反感，真的看不下去。' }).emotion).toBe('disgusted')
  })

  it('uses MiniMax auto emotion for ordinary speech instead of forcing calm', () => {
    expect(resolveVoiceProfile({ text: '我們先從第一項開始討論。' })).toMatchObject({
      emotion: undefined, style: 'conversation', speed: 1,
    })
  })
})

describe('live voice calls', () => {
  it('hard-limits spoken replies to 90 characters at a natural stop', () => {
    const input = `${'這是一段需要簡短口述的內容，'.repeat(8)}最後一句。`
    const result = clampVoiceCallReply(input)
    expect(result.length).toBeLessThanOrEqual(90)
    expect(result).toMatch(/[，。]$/)
  })

  it('uses faster live-call pacing without changing recorded voice defaults', () => {
    expect(resolveLiveVoiceProfile({ text: '我們先從最重要的地方開始。' })).toMatchObject({
      emotion: undefined, style: 'conversation', speed: 1.08,
    })
    expect(resolveLiveVoiceProfile({ text: '這是今天的 AI 新聞。' })).toMatchObject({
      style: 'news', speed: 1.1,
    })
  })

  it('splits one emotional turn into at most two live segments', () => {
    const segments = planVoiceCallSegments('我知道你今天真的很難過。可是我相信你一定做得到！後面我們再一起慢慢處理。')
    expect(segments).toHaveLength(2)
    expect(segments[0]).toMatchObject({ emotion: 'sad', style: 'comfort' })
    expect(segments[1]).toMatchObject({ emotion: 'happy', style: 'encourage' })
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
