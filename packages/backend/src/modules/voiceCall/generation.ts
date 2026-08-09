/** Prevents audio from a cancelled or superseded AI turn from reaching the caller. */
export class VoiceGeneration {
  private current = 0

  next(): number {
    this.current += 1
    return this.current
  }

  cancel(): number {
    return this.next()
  }

  isCurrent(generation: number): boolean {
    return generation === this.current
  }
}
