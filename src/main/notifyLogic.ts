// Pure notification rules (unit-tested); notifier.ts shows them with Electron.

const MAX_BODY = 140

export interface IncomingSummary {
  text: string
  hasImage: boolean
  /** Name of the attached file, if any. */
  file?: string
  voice?: boolean
  /** The channel it arrived in (absent = General). */
  channel?: string
}

/** Notify only when enabled and the user can't already see the chat. */
export function shouldNotify(enabled: boolean, windowFocused: boolean): boolean {
  return enabled && !windowFocused
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_BODY ? `${one.slice(0, MAX_BODY - 1)}…` : one
}

function describe(m: IncomingSummary): string {
  const text = clip(m.text)
  if (m.hasImage) return text ? `Image: ${text}` : 'Sent an image'
  if (m.voice) return 'Sent a voice note'
  if (m.file) return text ? `${clip(m.file)}: ${text}` : `Sent a file: ${clip(m.file)}`
  return text || 'New message'
}

/**
 * One notification for a burst of messages (e.g. several arriving after a sync).
 * Without `showText` it only says who wrote — nothing private appears on screen or lock screen.
 */
export function messageNotification(peerName: string, burst: IncomingSummary[], showText: boolean): { title: string; body: string } {
  if (!showText) {
    return { title: 'Hush', body: burst.length === 1 ? `New message from ${peerName}` : `${burst.length} new messages from ${peerName}` }
  }
  if (burst.length === 1) return { title: peerName, body: describe(burst[0]) }
  return { title: peerName, body: `${burst.length} new messages — ${describe(burst[burst.length - 1])}` }
}

/** "Hush", "Hush (3)", capped at 99+. */
export function titleWithUnread(unread: number): string {
  return unread > 0 ? `Hush (${unread > 99 ? '99+' : unread})` : 'Hush'
}

export function trayTooltip(peerName: string | null, online: boolean, unread: number): string {
  const who = peerName ? `${peerName} · ${online ? 'online' : 'offline'}` : 'No one linked yet'
  return unread > 0 ? `Hush — ${who} · ${unread} unread` : `Hush — ${who}`
}
