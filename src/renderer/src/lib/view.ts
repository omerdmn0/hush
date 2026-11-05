import type { Presence } from '../../../shared/types'

/** What the UI needs to know about the other person. */
export interface PeerView {
  name: string
  ip: string
  presence: Presence
  /** "13:11" — last time they were seen online, if ever. */
  lastSeen?: string
}

/** Whether the Call buttons work right now, and why not. */
export interface CallAction {
  enabled: boolean
  hint: string
  onCall: () => void
}
