import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, closeSync, readSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isUuid, sniffImage, type ImageMeta, type ImageMime } from '../shared/protocol'
import {
  EncryptedFileReader,
  EncryptedFileWriter,
  isEncryptedFile,
  openRecords,
  readEncryptedFile,
  recordsLength,
  sealRecord,
  writeEncryptedFile
} from './vault'

const EXT: Record<ImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

/**
 * Image files in the app data folder, named only by message UUID (never by anything the peer
 * chooses), so paths can't escape the folder. Everything is encrypted with the data key:
 *   <id>.<ext>        full image            <id>.thumb.webp   preview
 *   <id>.part         download in progress (sealed records; becomes the full file once its
 *                     SHA-256 matches)
 */
export class ImageStore {
  /** Plaintext bytes received per download in progress (avoids re-reading the part file). */
  private partSizes = new Map<string, number>()

  constructor(
    private readonly dir: string,
    private readonly key: Buffer
  ) {
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
    writeEncryptedFile(this.key, this.thumbPath(id), thumb)
    writeEncryptedFile(this.key, this.fullPath(id, meta.mime), bytes)
  }

  saveThumb(id: string, thumb: Uint8Array): void {
    writeEncryptedFile(this.key, this.thumbPath(id), thumb)
  }

  readThumbBase64(id: string): string {
    return readEncryptedFile(this.key, this.thumbPath(id)).toString('base64')
  }

  /** Reads up to `length` bytes of the full image starting at `offset` (decrypting only that range). */
  readChunk(id: string, meta: ImageMeta, offset: number, length: number): Uint8Array {
    const r = new EncryptedFileReader(this.key, this.fullPath(id, meta.mime))
    try {
      return r.read(offset, length)
    } finally {
      r.close()
    }
  }

  /** Plaintext bytes already received for a download (0 if none). */
  partSize(id: string): number {
    const cached = this.partSizes.get(id)
    if (cached !== undefined) return cached
    let size = 0
    try {
      const data = readFileSync(this.partPath(id))
      const { plain, bytes } = recordsLength(data)
      if (bytes !== data.length) truncateSync(this.partPath(id), bytes) // drop a torn final write
      size = plain
    } catch {
      size = 0
    }
    this.partSizes.set(id, size)
    return size
  }

  /**
   * Appends a received chunk (encrypted) if it continues the download exactly where it left off.
   * Returns the new size, or -1 when the chunk doesn't fit (caller re-requests).
   */
  appendPart(id: string, offset: number, data: Uint8Array, meta: ImageMeta): number {
    const size = this.partSize(id)
    if (offset !== size || size + data.length > meta.size) return -1
    writeFileSync(this.partPath(id), sealRecord(this.key, data), { flag: size === 0 ? 'w' : 'a' })
    this.partSizes.set(id, size + data.length)
    return size + data.length
  }

  /** Checks a finished download and moves it into place. False (and part deleted) if corrupt. */
  finalize(id: string, meta: ImageMeta): boolean {
    const part = this.partPath(id)
    const tmp = part + '.tmp'
    const hash = createHash('sha256')
    let head: Buffer | null = null
    let total = 0
    let ok = false
    try {
      const w = new EncryptedFileWriter(this.key, tmp)
      for (const piece of openRecords(this.key, readFileSync(part))) {
        if (!head) head = piece.subarray(0, 16)
        hash.update(piece)
        w.write(piece)
        total += piece.length
      }
      w.close()
      ok = total === meta.size && hash.digest('hex') === meta.sha256 && head !== null && sniffImage(head) === meta.mime
    } catch {
      ok = false
    }
    if (ok) renameSync(tmp, this.fullPath(id, meta.mime))
    else rmSync(tmp, { force: true })
    rmSync(part, { force: true })
    this.partSizes.delete(id)
    return ok
  }

  discardPart(id: string): void {
    rmSync(this.partPath(id), { force: true })
    this.partSizes.delete(id)
  }

  /** For the hush-img:// protocol: the decrypted image, or null. */
  readForDisplay(id: string, kind: string, meta: ImageMeta | null): Buffer | null {
    if (!isUuid(id)) return null
    const file = kind === 'thumb' ? this.thumbPath(id) : kind === 'full' && meta ? this.fullPath(id, meta.mime) : null
    if (!file || !existsSync(file)) return null
    try {
      return readEncryptedFile(this.key, file)
    } catch {
      return null
    }
  }

  /** One-time upgrade: encrypts images stored before encryption existed. Unfinished downloads restart. */
  encryptExisting(): number {
    let n = 0
    for (const name of readdirSync(this.dir)) {
      const file = join(this.dir, name)
      if (name.endsWith('.part')) {
        if (!isPlausibleRecordFile(file)) rmSync(file, { force: true }) // old plaintext download
        continue
      }
      if (name.endsWith('.tmp') || !statSync(file).isFile()) continue
      if (isEncryptedFile(readHead(file))) continue
      writeEncryptedFile(this.key, file + '.enc-tmp', readFileSync(file))
      renameSync(file + '.enc-tmp', file)
      n++
    }
    return n
  }
}

function readHead(file: string): Buffer {
  const fd = openSync(file, 'r')
  try {
    const b = Buffer.alloc(8)
    const n = readSync(fd, b, 0, 8, 0)
    return b.subarray(0, n)
  } finally {
    closeSync(fd)
  }
}

/** Old plaintext partial downloads can't be told apart reliably; encrypted ones parse cleanly. */
function isPlausibleRecordFile(file: string): boolean {
  const data = readFileSync(file)
  return recordsLength(data).bytes === data.length
}

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
