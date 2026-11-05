import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_AVATAR_BYTES, sniffImage } from '../shared/protocol'
import type { AvatarUrls } from '../shared/types'

const PICTURE = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Profile pictures: ours (sent to the peer) and theirs (received). Fixed file names. */
export class Avatars {
  private readonly self: string
  private readonly peer: string

  constructor(dir: string) {
    this.self = join(dir, 'avatar-self.img')
    this.peer = join(dir, 'avatar-peer.img')
  }

  /** Validates and stores (or removes, with null) a picture. Returns false if it isn't one. */
  private write(file: string, bytes: Uint8Array | null): boolean {
    if (bytes === null) {
      rmSync(file, { force: true })
      return true
    }
    if (bytes.length === 0 || bytes.length > MAX_AVATAR_BYTES || !PICTURE.has(sniffImage(bytes) ?? '')) return false
    writeFileSync(file, bytes)
    return true
  }

  setSelf(bytes: Uint8Array | null): boolean {
    return this.write(this.self, bytes)
  }

  setPeer(bytes: Uint8Array | null): boolean {
    return this.write(this.peer, bytes)
  }

  selfBase64(): string | null {
    return existsSync(this.self) ? readFileSync(this.self).toString('base64') : null
  }

  /** hush-img:// URLs with a version, so the UI reloads a changed picture. */
  urls(): AvatarUrls {
    const url = (file: string, kind: string): string | null =>
      existsSync(file) ? `hush-img://avatar/${kind}?v=${Math.round(statSync(file).mtimeMs)}` : null
    return { self: url(this.self, 'self'), peer: url(this.peer, 'peer') }
  }

  /** For the hush-img:// handler. */
  resolve(kind: string): string | null {
    const file = kind === 'self' ? this.self : kind === 'peer' ? this.peer : null
    return file && existsSync(file) ? file : null
  }
}
