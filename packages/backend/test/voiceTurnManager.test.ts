import { describe, expect, it, vi } from 'vitest'
import { VoiceTurnManager } from '../src/modules/voiceCall/turnManager.js'

describe('VoiceTurnManager', () => {
  it('interrupts both generation work and active playout on barge-in', () => {
    const interrupt = vi.fn()
    const manager = new VoiceTurnManager({ enabled: true })
    const generation = manager.startGeneration()
    manager.attachSpeech(generation.id, { interrupt })

    expect(manager.markUserSpeaking()).toBe(true)
    expect(generation.signal.aborted).toBe(true)
    expect(interrupt).toHaveBeenCalledWith(true)
    expect(manager.state).toBe('interrupted')
    expect(manager.isCurrent(generation.id)).toBe(false)
  })

  it('does not interrupt the legacy control group', () => {
    const interrupt = vi.fn()
    const manager = new VoiceTurnManager({ enabled: false })
    const generation = manager.startGeneration()
    manager.attachSpeech(generation.id, { interrupt })

    expect(manager.markUserSpeaking()).toBe(false)
    expect(generation.signal.aborted).toBe(false)
    expect(interrupt).not.toHaveBeenCalled()
  })

  it('rejects a late speech handle owned by an old generation', () => {
    const oldInterrupt = vi.fn()
    const manager = new VoiceTurnManager({ enabled: true })
    const oldGeneration = manager.startGeneration()
    manager.startGeneration()

    expect(manager.attachSpeech(oldGeneration.id, { interrupt: oldInterrupt })).toBe(false)
    expect(oldInterrupt).toHaveBeenCalledWith(true)
  })

  it('only completes the current generation', () => {
    const manager = new VoiceTurnManager({ enabled: true })
    const first = manager.startGeneration()
    const second = manager.startGeneration()

    expect(manager.complete(first.id)).toBe(false)
    expect(manager.complete(second.id)).toBe(true)
    expect(manager.state).toBe('idle')
  })

  it('returns to idle only when the current speech reports playout done', () => {
    let done: (() => void) | undefined
    const manager = new VoiceTurnManager({ enabled: true })
    const generation = manager.startGeneration()
    manager.attachSpeech(generation.id, {
      interrupt: vi.fn(),
      addDoneCallback: (callback) => { done = () => callback({ interrupt: vi.fn() }) },
    })

    expect(manager.state).toBe('agent_speaking')
    done?.()
    expect(manager.state).toBe('idle')
    expect(manager.hasActiveGeneration).toBe(false)
  })
})
