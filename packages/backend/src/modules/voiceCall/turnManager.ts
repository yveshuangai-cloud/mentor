export type VoiceTurnState =
  | 'idle'
  | 'user_speaking'
  | 'candidate_end'
  | 'committed'
  | 'agent_thinking'
  | 'agent_speaking'
  | 'interrupted'

export interface InterruptibleSpeech {
  interrupt(force?: boolean): unknown
  addDoneCallback?(callback: (speech: InterruptibleSpeech) => void): void
}

export interface VoiceGeneration {
  id: number
  signal: AbortSignal
}

interface VoiceTurnManagerOptions {
  enabled: boolean
  onEvent?: (event: string, payload: Record<string, unknown>) => void
}

/**
 * Owns one live-call generation at a time. The monotonically increasing ID is
 * the hard boundary that prevents late LLM or TTS chunks from an interrupted
 * reply from being delivered into the next turn.
 */
export class VoiceTurnManager {
  readonly enabled: boolean
  private generationId = 0
  private controller: AbortController | null = null
  private speech: InterruptibleSpeech | null = null
  private _state: VoiceTurnState = 'idle'
  private readonly onEvent: NonNullable<VoiceTurnManagerOptions['onEvent']>

  constructor(options: VoiceTurnManagerOptions) {
    this.enabled = options.enabled
    this.onEvent = options.onEvent ?? (() => undefined)
  }

  get state(): VoiceTurnState {
    return this._state
  }

  get currentGenerationId(): number {
    return this.generationId
  }

  get hasActiveGeneration(): boolean {
    return this.controller !== null && !this.controller.signal.aborted
  }

  markUserSpeaking(): boolean {
    this.transition('user_speaking')
    if (!this.enabled || !this.hasActiveGeneration) return false
    return this.interrupt('barge_in')
  }

  markCandidateEnd(): void {
    this.transition('candidate_end')
  }

  startGeneration(): VoiceGeneration {
    if (this.hasActiveGeneration) this.interrupt('superseded')
    this.generationId += 1
    this.controller = new AbortController()
    this.speech = null
    this.transition('committed', { generationId: this.generationId })
    this.transition('agent_thinking', { generationId: this.generationId })
    return { id: this.generationId, signal: this.controller.signal }
  }

  attachSpeech(generationId: number, speech: InterruptibleSpeech): boolean {
    if (!this.isCurrent(generationId)) {
      speech.interrupt(true)
      return false
    }
    this.speech = speech
    this.transition('agent_speaking', { generationId })
    speech.addDoneCallback?.(() => {
      if (this.isCurrent(generationId)) this.complete(generationId)
    })
    return true
  }

  isCurrent(generationId: number): boolean {
    return generationId === this.generationId
      && this.controller !== null
      && !this.controller.signal.aborted
  }

  ownsGeneration(generationId: number): boolean {
    return generationId === this.generationId
  }

  interrupt(reason: string): boolean {
    if (!this.hasActiveGeneration) return false
    const interruptedGenerationId = this.generationId
    this.controller!.abort(new DOMException('Voice generation interrupted', 'AbortError'))
    try {
      this.speech?.interrupt(true)
    } catch {
      // The speech may already have completed between the state check and the
      // interrupt call. The AbortSignal and generation ID still provide the
      // authoritative cancellation boundary.
    }
    this.speech = null
    this.transition('interrupted', { generationId: interruptedGenerationId, reason })
    this.onEvent('generation.interrupted', { generationId: interruptedGenerationId, reason })
    return true
  }

  complete(generationId: number): boolean {
    if (!this.isCurrent(generationId)) return false
    this.controller = null
    this.speech = null
    this.transition('idle', { generationId })
    this.onEvent('generation.completed', { generationId })
    return true
  }

  close(): void {
    if (this.hasActiveGeneration) this.interrupt('session_closed')
    this.controller = null
    this.speech = null
    this.transition('idle')
  }

  private transition(state: VoiceTurnState, payload: Record<string, unknown> = {}): void {
    const oldState = this._state
    this._state = state
    if (oldState !== state) this.onEvent('state.changed', { oldState, newState: state, ...payload })
  }
}
