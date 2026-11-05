// Ringtones synthesised with Web Audio — original sounds, nothing to bundle or download.

type Pattern = 'incoming' | 'ringback'

export class Ringer {
  private ctx: AudioContext | null = null
  private timer: ReturnType<typeof setInterval> | undefined
  private playing: Pattern | null = null

  /** Starts looping a pattern (no-op if it's already playing). */
  start(pattern: Pattern, sinkId?: string): void {
    if (this.playing === pattern) return
    this.stop()
    this.playing = pattern
    const ctx = new AudioContext()
    this.ctx = ctx
    if (sinkId) {
      // Ring on the chosen speaker where supported; fall back to the default output.
      ;(ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> }).setSinkId?.(sinkId).catch(() => {})
    }
    const play = (): void => (pattern === 'incoming' ? this.chime(ctx) : this.ringback(ctx))
    play()
    this.timer = setInterval(play, pattern === 'incoming' ? 2200 : 3000)
  }

  stop(): void {
    clearInterval(this.timer)
    this.playing = null
    void this.ctx?.close()
    this.ctx = null
  }

  /** Two rising notes with a soft bell envelope — the incoming call. */
  private chime(ctx: AudioContext): void {
    const t = ctx.currentTime
    ;[
      [659.25, 0], // E5
      [987.77, 0.18], // B5
      [1318.5, 0.36] // E6
    ].forEach(([freq, at]) => this.note(ctx, freq, t + at, 0.9, 0.22))
  }

  /** A low, quiet pulse — what the caller hears while it rings on the other side. */
  private ringback(ctx: AudioContext): void {
    const t = ctx.currentTime
    this.note(ctx, 440, t, 1.0, 0.06)
    this.note(ctx, 480, t, 1.0, 0.06)
  }

  private note(ctx: AudioContext, freq: number, at: number, length: number, volume: number): void {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0, at)
    gain.gain.linearRampToValueAtTime(volume, at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length)
    osc.connect(gain).connect(ctx.destination)
    osc.start(at)
    osc.stop(at + length + 0.05)
  }
}
