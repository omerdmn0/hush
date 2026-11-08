import { CHUNK_BYTES, decodeChunk, encodeChunk, type Frame } from '../shared/protocol'
import type { HushEvent, ImageTransfer } from '../shared/types'
import { AUTO_DOWNLOAD_BYTES, type HushDb, type StoredMessage } from './db'
import { blobOf, type BlobMeta, type ImageStore } from './images'
import type { PeerLink } from './link'

/** Re-request a download if no chunk arrives for this long. */
const STALL_MS = 15_000
/** Attempts per image before it is shown as failed (user can retry). */
const MAX_ATTEMPTS = 3
/** Progress events at most this often per transfer. */
const PROGRESS_EVERY_MS = 150

/**
 * Moves attachments (full-size images, files, voice notes) between the two computers.
 *
 * Receiving is pull-based: for every image message from the other person whose file we lack,
 * we ask for it (`blob-req`) from the number of bytes we already have, so an interrupted
 * download resumes where it stopped. One download runs at a time, in message order.
 */
export class Transfers {
  private queue: string[] = []
  private current: string | null = null
  private attempts = new Map<string, number>()
  private stallTimer: ReturnType<typeof setTimeout> | undefined
  private lastProgress = new Map<string, number>()
  /** Upload generation per image: a newer request for the same image cancels the older stream. */
  private uploads = new Map<string, number>()
  /** Downloads being checked and moved into place (async for big files). */
  private finishing = new Set<string>()
  /** Big files the user asked for (others download by themselves). */
  private requested = new Set<string>()
  private disposed = false

  constructor(
    private readonly db: HushDb,
    private readonly store: ImageStore,
    private readonly link: PeerLink,
    private readonly emit: (e: HushEvent) => void,
    private readonly chunkBytes: number = CHUNK_BYTES
  ) {
    link.on('binary', (data) => this.onChunk(data))
  }

  // ---------- receiving ----------

  /**
   * Queue an image for download (no-op if we have it or it's already queued). Normally these
   * are the peer's images; after recovering history from the peer, our own ones too.
   */
  want(id: string): void {
    const m = this.db.getMessage(id)
    const blob = m ? blobOf(m) : null
    if (!m || !blob || this.store.hasFull(id, blob) || !this.automatic(m)) return
    if (this.current === id || this.queue.includes(id) || this.finishing.has(id)) return
    this.queue.push(id)
    this.pump()
  }

  /** True while a file is moving in either direction. */
  get busy(): boolean {
    return this.current !== null || this.finishing.size > 0 || this.uploads.size > 0
  }

  /** Hush is closing: no more timers. */
  dispose(): void {
    this.disposed = true
    clearTimeout(this.stallTimer)
    this.uploads.clear()
  }

  /** The image was deleted: stop downloading or serving it. */
  cancel(id: string): void {
    this.queue = this.queue.filter((x) => x !== id)
    this.uploads.delete(id) // a running upload sees this and stops
    if (this.current === id) {
      clearTimeout(this.stallTimer)
      this.current = null
      this.pump()
    }
  }

  /** Images, voice notes and files up to 100 MB come by themselves; bigger files when asked (or already started). */
  private automatic(m: StoredMessage): boolean {
    return !m.file || !!m.file.voice || m.file.size <= AUTO_DOWNLOAD_BYTES || this.requested.has(m.id) || this.store.partSize(m.id) > 0
  }

  /** User pressed Retry on a failed download, or Download on a big file. */
  retry(id: string): void {
    this.attempts.delete(id)
    this.requested.add(id)
    this.want(id)
  }

  /**
   * Connected — or switched to the surviving duplicate connection, in which case chunks in
   * flight on the closed one are lost: resume the current download now instead of waiting
   * for the stall timer, then queue every other image we still lack.
   */
  onUp(): void {
    if (this.current) this.request(this.current)
    for (const { id } of this.db.attachmentMessages()) {
      if ((this.attempts.get(id) ?? 0) < MAX_ATTEMPTS) this.want(id)
    }
    this.pump()
  }

  /** Disconnected: keep partial files; they resume on the next connection. */
  onDown(): void {
    clearTimeout(this.stallTimer)
    if (this.current) this.queue.unshift(this.current)
    this.current = null
    // The other side resumes these if it still wants them; until then they aren't "sending".
    for (const id of this.uploads.keys()) this.progress(id, 'up', 'failed', 0, true)
    this.uploads.clear()
  }

  private pump(): void {
    if (this.current || !this.link.peer) return
    const id = this.queue.shift()
    if (!id) return
    this.current = id
    this.request(id)
  }

  private request(id: string): void {
    const offset = this.store.partSize(id)
    const m = this.db.getMessage(id)
    const blob = m ? blobOf(m) : null
    // Everything arrived before Hush stopped; it only still has to be checked.
    if (blob && offset >= blob.size) return this.finish(id, blob)
    if (blob) this.progress(id, 'down', 'active', offset / blob.size, true)
    void this.link.send({ t: 'blob-req', id, offset })
    this.armStall(id)
  }

  private armStall(id: string): void {
    clearTimeout(this.stallTimer)
    this.stallTimer = setTimeout(() => {
      if (this.current === id && this.link.peer) this.request(id)
    }, STALL_MS)
  }

  private onChunk(data: Uint8Array): void {
    const chunk = decodeChunk(data)
    if (!chunk || chunk.id !== this.current) return
    const m = this.db.getMessage(chunk.id)
    const meta = m ? blobOf(m) : null
    if (!meta) return
    let size: number
    try {
      size = this.store.appendPart(chunk.id, chunk.offset, chunk.data, meta)
    } catch {
      // Can't write (disk full?): this download fails, nothing else has to.
      clearTimeout(this.stallTimer)
      this.current = null
      this.fail(chunk.id)
      this.pump()
      return
    }
    if (size < 0) return // out of order (e.g. a cancelled stream); the stall timer re-requests
    this.armStall(chunk.id)
    if (size < meta.size) {
      this.progress(chunk.id, 'down', 'active', size / meta.size)
      return
    }
    this.finish(chunk.id, meta)
  }

  /** All bytes are here: check them and move the file into place (async for big files). */
  private finish(id: string, meta: BlobMeta): void {
    clearTimeout(this.stallTimer)
    this.current = null
    this.finishing.add(id)
    void this.store.finalize(id, meta).then((ok) => {
      if (this.disposed) return // the database is closed by now; the next start picks this up
      this.finishing.delete(id)
      const m = this.db.getMessage(id)
      if (!m || !blobOf(m)) {
        this.store.remove(id) // deleted while it was being checked
      } else if (ok) {
        this.attempts.delete(id)
        this.requested.delete(id)
        this.progress(id, 'down', 'done', 1, true)
      } else {
        this.fail(id) // corrupt: the part file was discarded, try from scratch
      }
      this.pump()
    })
    this.pump()
  }

  /** The owner can't serve it, or the file was corrupt: retry a few times, then report. */
  private fail(id: string): void {
    const n = (this.attempts.get(id) ?? 0) + 1
    this.attempts.set(id, n)
    if (n < MAX_ATTEMPTS) {
      this.queue.push(id)
    } else {
      this.store.discardPart(id)
      this.progress(id, 'down', 'failed', 0, true)
    }
  }

  // ---------- frames ----------

  onFrame(frame: Extract<Frame, { t: 'blob-req' } | { t: 'blob-err' }>): void {
    if (frame.t === 'blob-err') {
      if (this.current !== frame.id) return
      clearTimeout(this.stallTimer)
      this.current = null
      this.fail(frame.id)
      this.pump()
      return
    }
    void this.serve(frame.id, frame.offset).catch(() => {
      // The stored file can't be read: say so, or the other side waits forever.
      this.progress(frame.id, 'up', 'failed', 0, true)
      void this.link.send({ t: 'blob-err', id: frame.id })
    })
  }

  // ---------- sending ----------

  private async serve(id: string, offset: number): Promise<void> {
    const m = this.db.getMessage(id)
    const meta = m ? blobOf(m) : null
    // Any attachment we hold in full: ours, or theirs when they recover their history from us.
    if (!meta || !this.store.hasFull(id, meta) || offset > meta.size) {
      await this.link.send({ t: 'blob-err', id })
      return
    }
    const gen = (this.uploads.get(id) ?? 0) + 1
    this.uploads.set(id, gen)
    for (let at = offset; at < meta.size; at += this.chunkBytes) {
      if (this.uploads.get(id) !== gen) return // superseded by a newer request
      const data = this.store.readChunk(id, meta, at, this.chunkBytes)
      if (!(await this.link.sendBinary(encodeChunk(id, at, data)))) return // offline; they will resume
      const done = at + data.length
      this.progress(id, 'up', done >= meta.size ? 'done' : 'active', done / meta.size, done >= meta.size)
    }
    if (this.uploads.get(id) === gen) this.uploads.delete(id)
  }

  private progress(id: string, direction: ImageTransfer['direction'], state: ImageTransfer['state'], progress: number, force = false): void {
    const now = Date.now()
    if (!force && now - (this.lastProgress.get(id) ?? 0) < PROGRESS_EVERY_MS) return
    this.lastProgress.set(id, now)
    this.emit({ type: 'transfer', transfer: { id, direction, state, progress: Math.min(1, progress) } })
  }
}
