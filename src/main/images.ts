import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid, sniffImage, type ImageMeta, type ImageMime } from '../shared/protocol'

const EXT: Record<ImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

/**
 * Image files in the app data folder, named only by message UUID (never by anything the peer
 * chooses), so paths can't escape the folder:
 *   <id>.<ext>        full image            <id>.thumb.webp   preview
 *   <id>.part         download in progress (renamed to the full file after the SHA-256 matches)
 */
export class ImageStore {
  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true })
  }

  private base(id: string): string {
    if (!isUuid(id)) throw new Error('bad image id')
    return join(this.dir, id.toLowerCase())
  }

  fullPath(id: string, mime: ImageMime): string {
    return this.base(id) + EXT[mime]
  }

  thumbPath(id: string): string {
    return this.base(id) + '.thumb.webp'
  }

  private partPath(id: string): string {
    return this.base(id) + '.part'
  }

  hasFull(id: string, meta: ImageMeta | null): boolean {
    return meta !== null && existsSync(this.fullPath(id, meta.mime))
  }

  /** Stores an image written on this computer (already validated). */
  saveOwn(id: string, meta: ImageMeta, bytes: Uint8Array, thumb: Uint8Array): void {
    writeFileSync(this.thumbPath(id), thumb)
    writeFileSync(this.fullPath(id, meta.mime), bytes)
  }

  saveThumb(id: string, thumb: Uint8Array): void {
    writeFileSync(this.thumbPath(id), thumb)
  }

  readThumbBase64(id: string): string {
    return readFileSync(this.thumbPath(id)).toString('base64')
  }

  /** Reads up to `length` bytes of the full image starting at `offset`. */
  readChunk(id: string, meta: ImageMeta, offset: number, length: number): Uint8Array {
    const fd = openSync(this.fullPath(id, meta.mime), 'r')
    try {
      const buf = Buffer.alloc(Math.max(0, Math.min(length, meta.size - offset)))
      const n = readSync(fd, buf, 0, buf.length, offset)
      return buf.subarray(0, n)
    } finally {
      closeSync(fd)
    }
  }

  /** Bytes already received for a download (0 if none). */
  partSize(id: string): number {
    try {
      return statSync(this.partPath(id)).size
    } catch {
      return 0
    }
  }

  /**
   * Appends a received chunk if it continues the download exactly where it left off.
   * Returns the new size, or -1 when the chunk doesn't fit (caller re-requests).
   */
  appendPart(id: string, offset: number, data: Uint8Array, meta: ImageMeta): number {
    const size = this.partSize(id)
    if (offset !== size || size + data.length > meta.size) return -1
    writeFileSync(this.partPath(id), data, { flag: size === 0 ? 'w' : 'a' })
    return size + data.length
  }

  /** Checks a finished download and moves it into place. False (and part deleted) if corrupt. */
  finalize(id: string, meta: ImageMeta): boolean {
    const part = this.partPath(id)
    const bytes = readFileSync(part)
    const ok = bytes.length === meta.size && sha256(bytes) === meta.sha256 && sniffImage(bytes) === meta.mime
    if (ok) renameSync(part, this.fullPath(id, meta.mime))
    else rmSync(part, { force: true })
    return ok
  }

  discardPart(id: string): void {
    rmSync(this.partPath(id), { force: true })
  }

  /** For the hush-img:// protocol: path of a stored file, or null. */
  resolve(id: string, kind: string, meta: ImageMeta | null): string | null {
    if (!isUuid(id)) return null
    const file = kind === 'thumb' ? this.thumbPath(id) : kind === 'full' && meta ? this.fullPath(id, meta.mime) : null
    return file && existsSync(file) ? file : null
  }
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
