// Types shared by the main process, preload and renderer.

export type MessageStatus = 'queued' | 'sent' | 'delivered' | 'read'

export interface ChatImage {
  src: string
  width: number
  height: number
  alt?: string
}

export interface ChatMessage {
  /** UUID — also the sync key between the two computers (stage c). */
  id: string
  from: 'me' | 'peer'
  text: string
  /** Unix epoch milliseconds. */
  sentAt: number
  status: MessageStatus
  image?: ChatImage
}

export type Presence = 'online' | 'offline'

/** API the preload script exposes to the renderer as `window.hush`. */
export interface HushApi {
  platform: string
  /** This computer's Tailscale IPv4 address, or null if Tailscale isn't running. */
  getTailscaleIp(): Promise<string | null>
}

export const IPC = {
  tailscaleIp: 'net:tailscale-ip'
} as const
