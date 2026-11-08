import { Notification } from 'electron'
import { GENERAL_CHANNEL } from '../shared/protocol'
import { messageNotification, shouldNotify, type IncomingSummary } from './notifyLogic'

/** Messages arriving within this window become one notification ("3 new messages"). */
const BURST_MS = 800

interface NotifierOptions {
  enabled: () => boolean
  /** Include message text (otherwise only who wrote). */
  preview: () => boolean
  /** True when the user is looking at Hush (no notification needed). */
  focused: () => boolean
  peerName: () => string
  icon: string
  /** `channel` is set when the notification was about messages in that channel. */
  onClick: (channel?: string) => void
  muted?: (channel: string) => boolean
  channelName?: (id: string) => string | undefined
  /** Dev pairing mode: also log notifications (for automated tests). */
  log?: (line: string) => void
}

/** Desktop notifications for messages and calls. Clicking one opens Hush. */
export class Notifier {
  /** Kept alive so click handlers still fire (notifications can be garbage-collected otherwise). */
  private live = new Map<Notification, string | undefined>()
  private burst: IncomingSummary[] = []
  private burstTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly o: NotifierOptions) {}

  /** Hush is closing: a waiting burst would read the closed database. */
  dispose(): void {
    clearTimeout(this.burstTimer)
    this.burst = []
  }

  message(m: IncomingSummary): void {
    if (!shouldNotify(this.o.enabled(), this.o.focused()) || this.o.muted?.(m.channel ?? GENERAL_CHANNEL)) return
    this.burst.push(m)
    if (this.burstTimer) return
    this.burstTimer = setTimeout(() => {
      this.burstTimer = undefined
      const burst = this.burst.splice(0)
      if (burst.length && shouldNotify(this.o.enabled(), this.o.focused())) {
        const { title, body } = messageNotification(this.o.peerName(), burst, this.o.preview(), this.o.channelName)
        this.show(title, body, 'normal', burst[burst.length - 1].channel ?? GENERAL_CHANNEL)
      }
    }, BURST_MS)
  }

  /** A channel was erased: nothing waiting to be shown may mention it any more. */
  dropChannel(id: string): void {
    this.burst = this.burst.filter((m) => m.channel !== id)
    for (const [n, channel] of this.live) {
      if (channel !== id) continue
      this.live.delete(n)
      n.close()
    }
  }

  incomingCall(): void {
    if (shouldNotify(this.o.enabled(), this.o.focused())) this.show('Incoming call', `${this.o.peerName()} is calling`, 'critical')
  }

  missedCall(): void {
    if (shouldNotify(this.o.enabled(), this.o.focused())) this.show('Missed call', `${this.o.peerName()} called you`)
  }

  /** One-off information (e.g. "still running in the tray"); shown even when messages are muted. */
  info(title: string, body: string): void {
    this.show(title, body)
  }

  private show(title: string, body: string, urgency: 'normal' | 'critical' = 'normal', channel?: string): void {
    this.o.log?.(`[notify] ${title} | ${body}`)
    if (!Notification.isSupported()) return
    const n = new Notification({ title, body, icon: this.o.icon, urgency })
    this.live.set(n, channel)
    n.on('click', () => this.o.onClick(channel))
    n.on('close', () => this.live.delete(n))
    n.show()
    // Drop references after a while even if the OS never reports "close".
    setTimeout(() => this.live.delete(n), 60_000)
  }
}
