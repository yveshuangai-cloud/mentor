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
  private outputAudioStarted = false
  private queuedInput = ''
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

  get hasOutputAudioStarted(): boolean {
    return this.hasActiveGeneration && this.outputAudioStarted
  }

  get hasQueuedInput(): boolean {
    return this.queuedInput.length > 0
  }

  markUserSpeaking(): boolean {
    this.transition('user_speaking')
    // A transcript that arrives while the model is still thinking is usually a
    // continuation (or a caller checking whether the call is alive), not a
    // barge-in. Cancelling before any audio is emitted can starve the caller of
    // every reply. Only interrupt an answer that has actually begun playout.
    if (!this.enabled || !this.hasOutputAudioStarted) return false
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
    this.outputAudioStarted = false
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

  markOutputAudioStarted(generationId: number): boolean {
    if (!this.isCurrent(generationId)) return false
    this.outputAudioStarted = true
    this.onEvent('output.started', { generationId })
    return true
  }

  queueInput(input: string): void {
    const normalized = input.trim()
    if (!normalized) return
    this.queuedInput = `${this.queuedInput} ${normalized}`.trim()
    this.onEvent('input.queued', {
      queuedChars: this.queuedInput.length,
      generationId: this.generationId,
    })
  }

  takeQueuedInput(): string {
    const input = this.queuedInput
    this.queuedInput = ''
    return input
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
    this.outputAudioStarted = false
    this.transition('interrupted', { generationId: interruptedGenerationId, reason })
    this.onEvent('generation.interrupted', { generationId: interruptedGenerationId, reason })
    return true
  }

  complete(generationId: number): boolean {
    if (!this.isCurrent(generationId)) return false
    this.controller = null
    this.speech = null
    this.outputAudioStarted = false
    this.transition('idle', { generationId })
    this.onEvent('generation.completed', { generationId })
    return true
  }

  close(): void {
    if (this.hasActiveGeneration) this.interrupt('session_closed')
    this.controller = null
    this.speech = null
    this.outputAudioStarted = false
    this.queuedInput = ''
    this.transition('idle')
  }

  private transition(state: VoiceTurnState, payload: Record<string, unknown> = {}): void {
    const oldState = this._state
    this._state = state
    if (oldState !== state) this.onEvent('state.changed', { oldState, newState: state, ...payload })
  }
}
