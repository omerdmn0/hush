import type { CallSignal } from '../shared/protocol'

/**
 * Follows call signaling as it passes through the main process (the UI owns the actual call).
 * Used to notice missed calls for notifications, and to hang up properly when Hush quits.
 */
export class CallTracker {
  /** Incoming invitations and whether we answered them. */
  private incoming = new Map<string, boolean>()
  /** Calls that started (either way) and haven't ended. */
  private open = new Set<string>()
  /** Open calls that were answered: their audio goes directly, so they outlast the chat link. */
  private answered = new Set<string>()

  /** A signal from the other app. Returns what happened, for notifications. */
  fromPeer(s: CallSignal): 'incoming' | 'missed' | null {
    if (s.t === 'call') {
      this.incoming.set(s.id, false)
      this.open.add(s.id)
      return 'incoming'
    }
    if (s.t === 'call-answer') this.answered.add(s.id)
    if (s.t === 'call-end') {
      this.open.delete(s.id)
      this.answered.delete(s.id)
      const answered = this.incoming.get(s.id)
      this.incoming.delete(s.id)
      // They gave up (cancelled) or it rang out before we answered.
      if (answered === false && (s.reason === 'cancelled' || s.reason === 'timeout')) return 'missed'
    }
    return null
  }

  /** A signal from our UI to the other app. */
  fromUs(s: CallSignal): void {
    if (s.t === 'call') this.open.add(s.id)
    else if (s.t === 'call-answer') {
      this.answered.add(s.id)
      if (this.incoming.has(s.id)) this.incoming.set(s.id, true)
    } else if (s.t === 'call-end') {
      this.open.delete(s.id)
      this.answered.delete(s.id)
      this.incoming.delete(s.id)
    }
  }

  /** The link dropped: a call still ringing can't connect now, and its end won't be signalled. */
  linkDown(): void {
    for (const id of this.open) {
      if (this.answered.has(id)) continue
      this.open.delete(id)
      this.incoming.delete(id)
    }
  }

  /** Calls to hang up before quitting. */
  openCalls(): string[] {
    return [...this.open]
  }
}
