import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { open as openAsync } from 'node:fs/promises'
import { join } from 'node:path'
import { isUuid, sniffImage, type FileMeta, type ImageMeta, type ImageMime } from '../shared/protocol'
import {
  EncryptedFileReader,
  EncryptedFileWriter,
  isEncryptedFile,
  readEncryptedFile,
  recordsFromFile,
  recordsLength,
  scanRecordFile,
  sealRecord,
  writeEncryptedFile
} from './vault'

const EXT: Record<ImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp'
}

/** What the store needs to know about an attachment: an image, a file, or a voice note. */
export interface BlobMeta {
  size: number
  sha256: string
  mime: string
  /** Absent for images. */
  file?: 'file' | 'voice'
}

/** The attachment of a message, if it has one. */
export function blobOf(m: { image?: ImageMeta | null; file?: FileMeta | null }): BlobMeta | null {
  if (m.image) return m.image
  if (m.file) return { size: m.file.size, sha256: m.file.sha256, mime: m.file.mime, file: m.file.voice ? 'voice' : 'file' }
  return null
}

/** Copy/hash in steps of this size, yielding in between so chat and calls stay responsive. */
const STEP = 1024 * 1024
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/**
 * Attachments (images, files, voice notes) in the app data folder, named only by message UUID
 * (never by anything the peer chooses), so paths can't escape the folder. Everything is
 * encrypted with the data key:
 *   <id>.<ext>   full image      <id>.thumb.webp   preview      <id>.file / <id>.voice   files
 *   <id>.part    download in progress (sealed records; becomes the full file once its
 *                SHA-256 matches)
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

  fullPath(id: string, meta: BlobMeta): string {
    if (meta.file) return this.base(id) + (meta.file === 'voice' ? '.voice' : '.file')
    return this.base(id) + EXT[meta.mime as ImageMime]
  }

  thumbPath(id: string): string {
    return this.base(id) + '.thumb.webp'
  }

  private partPath(id: string): string {
    return this.base(id) + '.part'
  }

  hasFull(id: string, meta: BlobMeta | null): boolean {
    return meta !== null && existsSync(this.fullPath(id, meta))
  }

  /** Stores an image written on this computer (already validated). */
  saveOwn(id: string, meta: ImageMeta, bytes: Uint8Array, thumb: Uint8Array): void {
    writeEncryptedFile(this.key, this.thumbPath(id), thumb)
    writeEncryptedFile(this.key, this.fullPath(id, meta), bytes)
  }

  saveThumb(id: string, thumb: Uint8Array): void {
    writeEncryptedFile(this.key, this.thumbPath(id), thumb)
  }

  /** Stores a small file from memory (pasted, voice note). Returns its SHA-256. */
  saveOwnBytes(id: string, kind: 'file' | 'voice', bytes: Uint8Array): string {
    writeEncryptedFile(this.key, this.fullPath(id, { size: bytes.length, sha256: '', mime: '', file: kind }), bytes)
    return sha256(bytes)
  }

  /**
   * Copies a file from disk into the store, encrypting and hashing as it streams (files can be
   * 1 GB). Stops with an error if the file grows past `maxBytes` while being read.
   */
  async importFile(id: string, src: string, maxBytes: number): Promise<{ size: number; sha256: string }> {
    const dest = this.fullPath(id, { size: 0, sha256: '', mime: '', file: 'file' })
    const tmp = dest + '.tmp'
    const hash = createHash('sha256')
    const w = new EncryptedFileWriter(this.key, tmp)
    const fh = await openAsync(src, 'r')
    let size = 0
    try {
      const buf = Buffer.alloc(STEP)
      for (;;) {
        const { bytesRead } = await fh.read(buf, 0, STEP, null)
        if (bytesRead === 0) break
        size += bytesRead
        if (size > maxBytes) throw new Error('File is too big')
        const piece = buf.subarray(0, bytesRead)
        hash.update(piece)
        w.write(piece)
      }
      w.close()
      if (size === 0) throw new Error('File is empty')
      renameSync(tmp, dest)
      return { size, sha256: hash.digest('hex') }
    } catch (e) {
      w.close()
      rmSync(tmp, { force: true })
      throw e
    } finally {
      await fh.close()
    }
  }

  readThumbBase64(id: string): string {
    return readEncryptedFile(this.key, this.thumbPath(id)).toString('base64')
  }

  /** Reads up to `length` bytes of the attachment starting at `offset` (decrypting only that range). */
  readChunk(id: string, meta: BlobMeta, offset: number, length: number): Uint8Array {
    const r = new EncryptedFileReader(this.key, this.fullPath(id, meta))
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
    const size = scanRecordFile(this.partPath(id)) // also drops a torn final write
    this.partSizes.set(id, size)
    return size
  }

  /**
   * Appends a received chunk (encrypted) if it continues the download exactly where it left off.
   * Returns the new size, or -1 when the chunk doesn't fit (caller re-requests).
   */
  appendPart(id: string, offset: number, data: Uint8Array, meta: BlobMeta): number {
    const size = this.partSize(id)
    if (offset !== size || size + data.length > meta.size) return -1
    writeFileSync(this.partPath(id), sealRecord(this.key, data), { flag: size === 0 ? 'w' : 'a' })
    this.partSizes.set(id, size + data.length)
    return size + data.length
  }

  /** Checks a finished download and moves it into place. False (and part deleted) if corrupt. */
  async finalize(id: string, meta: BlobMeta): Promise<boolean> {
    const part = this.partPath(id)
    const tmp = part + '.tmp'
    const hash = createHash('sha256')
    let head: Buffer | null = null
    let total = 0
    let ok = false
    try {
      const w = new EncryptedFileWriter(this.key, tmp)
      let sinceYield = 0
      for (const piece of recordsFromFile(this.key, part)) {
        if (!head) head = piece.subarray(0, 16)
        hash.update(piece)
        w.write(piece)
        total += piece.length
        sinceYield += piece.length
        if (sinceYield >= STEP * 8) {
          sinceYield = 0
          await tick()
        }
      }
      w.close()
      ok = total === meta.size && hash.digest('hex') === meta.sha256 && head !== null && (!!meta.file || sniffImage(head) === meta.mime)
    } catch {
      ok = false
    }
    if (ok) renameSync(tmp, this.fullPath(id, meta))
    else rmSync(tmp, { force: true })
    rmSync(part, { force: true })
    this.partSizes.delete(id)
    return ok
  }

  /** Writes the decrypted attachment to a place the user chose (via a temporary file). */
  async exportTo(id: string, meta: BlobMeta, dest: string): Promise<void> {
    const tmp = `${dest}.hush-saving`
    const r = new EncryptedFileReader(this.key, this.fullPath(id, meta))
    const fh = await openAsync(tmp, 'w')
    try {
      for (const piece of r.chunksInOrder()) await fh.write(piece)
      await fh.close()
      renameSync(tmp, dest)
    } catch (e) {
      await fh.close().catch(() => {})
      rmSync(tmp, { force: true })
      throw e
    } finally {
      r.close()
    }
  }

  /** Erases every file of an attachment (deleted message). */
  remove(id: string): void {
    for (const ext of [...Object.values(EXT), '.thumb.webp', '.part', '.file', '.voice']) rmSync(this.base(id) + ext, { force: true })
    this.partSizes.delete(id)
  }

  discardPart(id: string): void {
    rmSync(this.partPath(id), { force: true })
    this.partSizes.delete(id)
  }

  /** For the hush-img:// protocol: the decrypted image / voice note, or null. */
  readForDisplay(id: string, kind: string, meta: BlobMeta | null): Buffer | null {
    if (!isUuid(id)) return null
    const file =
      kind === 'thumb'
        ? this.thumbPath(id)
        : (kind === 'full' && meta && !meta.file) || (kind === 'voice' && meta?.file === 'voice')
          ? this.fullPath(id, meta)
          : null
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
