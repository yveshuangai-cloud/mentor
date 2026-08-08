import { describe, expect, it } from 'vitest'
import { sanitizeConversationalText, splitIntoLineBubbles } from '../src/modules/conversationStyle.js'

describe('LINE conversation style', () => {
  it('removes Markdown stars, bullets, headings, and repeated dashes', () => {
    const result = sanitizeConversationalText(
      '## 核心判斷\n\n- **先看問題。**\n- 再做實驗——不要急。\n---',
    )

    expect(result).toBe('核心判斷\n先看問題。\n再做實驗，不要急。')
    expect(result).not.toMatch(/[＊*]|^-\s/m)
  })

  it('groups a long reply into human-sized bubbles of two to three sentences', () => {
    const result = splitIntoLineBubbles(
      '先把問題看清楚。這不是能力不足。比較像是順序需要調整。先做一個小實驗。看結果再修正。這樣壓力也會小一點。',
    )

    expect(result).toEqual([
      '先把問題看清楚。這不是能力不足。比較像是順序需要調整。',
      '先做一個小實驗。看結果再修正。這樣壓力也會小一點。',
    ])
  })

  it('never drops text when the LINE bubble budget is smaller', () => {
    const result = splitIntoLineBubbles('一。二。三。四。五。六。七。八。', 2)

    expect(result).toHaveLength(2)
    expect(result.join('').replace(/\n/g, '')).toBe('一。二。三。四。五。六。七。八。')
  })

  it('corrects the historical Yves typo at the final output boundary', () => {
    expect(sanitizeConversationalText('義父說得對，請回覆義父。')).toBe('Yves說得對，請回覆Yves。')
  })
})
