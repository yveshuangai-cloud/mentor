import { describe, expect, it } from 'vitest'
import { issueVoiceToken, verifyVoiceToken } from '../src/modules/voiceCall/auth.js'
import { VoiceGeneration } from '../src/modules/voiceCall/generation.js'
import { isVoiceCallTrigger } from '../src/modules/voiceCall/trigger.js'

describe('voice call session tokens', () => {
  it('binds a short-lived token to a LINE user and a session', () => {
    const token = issueVoiceToken('U-test', '4d978bcc-c6d1-4610-a5dc-6cbde113c00a')
    const payload = verifyVoiceToken(token)
    expect(payload.sub).toBe('U-test')
    expect(payload.sid).toBe('4d978bcc-c6d1-4610-a5dc-6cbde113c00a')
  })

  it('rejects tampering and expiry', () => {
    const token = issueVoiceToken('U-test', 'session', 10)
    expect(() => verifyVoiceToken(`${token}x`)).toThrow('invalid_voice_token')
    expect(() => verifyVoiceToken(issueVoiceToken('U-test', 'session', -1))).toThrow('expired_voice_token')
  })
})

describe('voice generation cancellation', () => {
  it('invalidates audio from the interrupted turn', () => {
    const generations = new VoiceGeneration()
    const first = generations.next()
    generations.cancel()
    expect(generations.isCurrent(first)).toBe(false)
    expect(generations.isCurrent(generations.next())).toBe(true)
  })
})

describe('voice call keyword', () => {
  it('only accepts deliberate call commands', () => {
    expect(isVoiceCallTrigger('打電話')).toBe(true)
    expect(isVoiceCallTrigger('跟饅頭通話！')).toBe(true)
    expect(isVoiceCallTrigger('你可以打電話嗎')).toBe(false)
  })
})
