import { existsSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_AVATAR_BYTES, sniffImage } from '../shared/protocol'
import type { AvatarUrls } from '../shared/types'
import { isEncryptedFile, readEncryptedFile, writeEncryptedFile } from './vault'

const PICTURE = new Set(['image/png', 'image/jpeg', 'image/webp'])

/** Profile pictures: ours (sent to the peer) and theirs (received). Fixed file names, encrypted. */
export class Avatars {
  private readonly self: string
  private readonly peer: string

  constructor(
    dir: string,
    private readonly key: Buffer
  ) {
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
    writeEncryptedFile(this.key, file, bytes)
    return true
  }

  setSelf(bytes: Uint8Array | null): boolean {
    return this.write(this.self, bytes)
  }

  setPeer(bytes: Uint8Array | null): boolean {
    return this.write(this.peer, bytes)
  }

  selfBase64(): string | null {
    return existsSync(this.self) ? readEncryptedFile(this.key, this.self).toString('base64') : null
  }

  /** hush-img:// URLs with a version, so the UI reloads a changed picture. */
  urls(): AvatarUrls {
    const url = (file: string, kind: string): string | null =>
      existsSync(file) ? `hush-img://avatar/${kind}?v=${Math.round(statSync(file).mtimeMs)}` : null
    return { self: url(this.self, 'self'), peer: url(this.peer, 'peer') }
  }

  /** For the hush-img:// handler: the decrypted picture, or null. */
  readForDisplay(kind: string): Buffer | null {
    const file = kind === 'self' ? this.self : kind === 'peer' ? this.peer : null
    if (!file || !existsSync(file)) return null
    try {
      return readEncryptedFile(this.key, file)
    } catch {
      return null
    }
  }

  /** Whether a picture is stored (for tests). */
  has(kind: 'self' | 'peer'): boolean {
    return existsSync(kind === 'self' ? this.self : this.peer)
  }

  /** One-time upgrade of pictures stored before encryption existed. */
  encryptExisting(): void {
    for (const file of [this.self, this.peer]) {
      if (!existsSync(file) || isEncryptedFile(readFileSync(file).subarray(0, 8))) continue
      writeEncryptedFile(this.key, file + '.tmp', readFileSync(file))
      renameSync(file + '.tmp', file)
    }
  }
}
