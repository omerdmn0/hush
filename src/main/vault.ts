import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, writeSync } from 'node:fs'

/**
 * Encryption at rest. One random 256-bit data key encrypts message text, secrets and every
 * stored file (AES-256-GCM). The data key itself is protected either by the OS keychain or by
 * an app password (see keyring in index.ts).
 */

export const KEY_BYTES = 32
const NONCE = 12
const TAG = 16

export const newDataKey = (): Buffer => randomBytes(KEY_BYTES)

// ---------- small values (database fields, secrets) ----------

const FIELD_PREFIX = 'enc1:'

export interface FieldCipher {
  seal(plain: string): string
  open(sealed: string): string
}

/** Encrypts short strings into "enc1:<base64 nonce|ciphertext|tag>". Empty strings stay empty. */
export function fieldCipher(key: Buffer): FieldCipher {
  return {
    seal(plain) {
      if (plain === '') return ''
      const nonce = randomBytes(NONCE)
      const c = createCipheriv('aes-256-gcm', key, nonce)
      const body = Buffer.concat([c.update(plain, 'utf8'), c.final()])
      return FIELD_PREFIX + Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64')
    },
    open(sealed) {
      if (!sealed.startsWith(FIELD_PREFIX)) return sealed // not encrypted (yet)
      const raw = Buffer.from(sealed.slice(FIELD_PREFIX.length), 'base64')
      const d = createDecipheriv('aes-256-gcm', key, raw.subarray(0, NONCE))
      d.setAuthTag(raw.subarray(raw.length - TAG))
      return Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()]).toString('utf8')
    }
  }
}

export const isSealedField = (s: string): boolean => s.startsWith(FIELD_PREFIX)

/** For tests and unencrypted use: stores values as they are. */
export const plainFields: FieldCipher = { seal: (s) => s, open: (s) => s }

// ---------- password-based wrapping (app password, backups) ----------

export interface KdfParams {
  salt: string
  N: number
  r: number
  p: number
}

export function newKdfParams(): KdfParams {
  return { salt: randomBytes(16).toString('base64'), N: 1 << 15, r: 8, p: 1 }
}

/** scrypt: deliberately slow, so password guessing is expensive. */
export function deriveKey(password: string, kdf: KdfParams): Buffer {
  return scryptSync(password.normalize('NFC'), Buffer.from(kdf.salt, 'base64'), KEY_BYTES, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 128 * kdf.N * kdf.r * 2 })
}

/** Encrypts a key with another key (AES-256-GCM). */
export function wrapKey(key: Buffer, kek: Buffer): string {
  const nonce = randomBytes(NONCE)
  const c = createCipheriv('aes-256-gcm', kek, nonce)
  const body = Buffer.concat([c.update(key), c.final()])
  return Buffer.concat([nonce, body, c.getAuthTag()]).toString('base64')
}

/** Throws if the wrapping key is wrong (e.g. wrong password). */
export function unwrapKey(wrapped: string, kek: Buffer): Buffer {
  const raw = Buffer.from(wrapped, 'base64')
  const d = createDecipheriv('aes-256-gcm', kek, raw.subarray(0, NONCE))
  d.setAuthTag(raw.subarray(raw.length - TAG))
  return Buffer.concat([d.update(raw.subarray(NONCE, raw.length - TAG)), d.final()])
}

// ---------- files: chunked AES-256-GCM with random access ----------
//
// Layout: "HUSHENC1" (8) | base nonce (12) | chunks…
// Each chunk = up to CHUNK plaintext bytes encrypted on its own (+16-byte tag). Its nonce is the
// base nonce with the chunk index mixed in, and its index + "is last" flag are authenticated, so
// chunks can't be reordered, swapped between files, or dropped from the end unnoticed.

const FILE_MAGIC = Buffer.from('HUSHENC1')
const HEADER = FILE_MAGIC.length + NONCE
export const FILE_CHUNK = 128 * 1024
const SEALED_CHUNK = FILE_CHUNK + TAG

function chunkNonce(base: Buffer, index: number): Buffer {
  const n = Buffer.from(base)
  n.writeUInt32BE((n.readUInt32BE(NONCE - 4) ^ index) >>> 0, NONCE - 4)
  return n
}

function chunkAad(index: number, last: boolean): Buffer {
  const aad = Buffer.alloc(5)
  aad.writeUInt32BE(index, 0)
  aad[4] = last ? 1 : 0
  return aad
}

function sealChunk(key: Buffer, base: Buffer, index: number, last: boolean, plain: Uint8Array): Buffer {
  const c = createCipheriv('aes-256-gcm', key, chunkNonce(base, index))
  c.setAAD(chunkAad(index, last))
  return Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
}

function openChunk(key: Buffer, base: Buffer, index: number, last: boolean, sealed: Buffer): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, chunkNonce(base, index))
  d.setAAD(chunkAad(index, last))
  d.setAuthTag(sealed.subarray(sealed.length - TAG))
  return Buffer.concat([d.update(sealed.subarray(0, sealed.length - TAG)), d.final()])
}

export const isEncryptedFile = (head: Uint8Array): boolean => Buffer.from(head.subarray(0, FILE_MAGIC.length)).equals(FILE_MAGIC)

/**
 * Writes plaintext pieces of any size as one encrypted file. Streams; never holds the whole file.
 * `prefix` (optional) is written unencrypted before the encrypted part (used by backups).
 */
export class EncryptedFileWriter {
  private readonly fd: number
  private readonly base = randomBytes(NONCE)
  private pending = Buffer.alloc(0)
  private index = 0
  private closed = false

  constructor(
    private readonly key: Buffer,
    path: string,
    prefix: Buffer = Buffer.alloc(0)
  ) {
    this.fd = openSync(path, 'w')
    writeSync(this.fd, Buffer.concat([prefix, FILE_MAGIC, this.base]))
  }

  write(data: Uint8Array): void {
    this.pending = this.pending.length ? Buffer.concat([this.pending, data]) : Buffer.from(data)
    // Keep at least one byte back: the final chunk must be sealed with the "last" flag.
    while (this.pending.length > FILE_CHUNK) {
      writeSync(this.fd, sealChunk(this.key, this.base, this.index++, false, this.pending.subarray(0, FILE_CHUNK)))
      this.pending = this.pending.subarray(FILE_CHUNK)
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    writeSync(this.fd, sealChunk(this.key, this.base, this.index, true, this.pending))
    closeSync(this.fd)
  }
}

export function writeEncryptedFile(key: Buffer, path: string, data: Uint8Array): void {
  const w = new EncryptedFileWriter(key, path)
  w.write(data)
  w.close()
}

/** Plaintext size of an encrypted file, from its length alone. */
function plainSize(fileSize: number): number {
  const body = fileSize - HEADER
  if (body < TAG) throw new Error('Encrypted file is truncated')
  const full = Math.floor(body / SEALED_CHUNK)
  const rest = body - full * SEALED_CHUNK
  // A file whose plaintext is an exact multiple of the chunk size ends with a full sealed chunk.
  return rest === 0 ? full * FILE_CHUNK : full * FILE_CHUNK + (rest - TAG)
}

/** Random-access reader: decrypts only the chunks a range needs. `start` skips a plain prefix. */
export class EncryptedFileReader {
  private readonly fd: number
  private readonly base: Buffer
  readonly size: number
  private readonly chunks: number

  constructor(
    private readonly key: Buffer,
    path: string,
    private readonly start = 0
  ) {
    this.fd = openSync(path, 'r')
    const head = Buffer.alloc(HEADER)
    readSync(this.fd, head, 0, HEADER, start)
    if (!isEncryptedFile(head)) {
      closeSync(this.fd)
      throw new Error('Not an encrypted Hush file')
    }
    this.base = head.subarray(FILE_MAGIC.length)
    this.size = plainSize(fstatSync(this.fd).size - start)
    this.chunks = Math.max(1, Math.ceil(this.size / FILE_CHUNK))
  }

  private chunk(i: number): Buffer {
    const last = i === this.chunks - 1
    const len = (last ? this.size - i * FILE_CHUNK : FILE_CHUNK) + TAG
    const buf = Buffer.alloc(len)
    readSync(this.fd, buf, 0, len, this.start + HEADER + i * SEALED_CHUNK)
    return openChunk(this.key, this.base, i, last, buf)
  }

  read(offset: number, length: number): Buffer {
    const end = Math.min(this.size, offset + length)
    if (offset >= end) return Buffer.alloc(0)
    const parts: Buffer[] = []
    for (let i = Math.floor(offset / FILE_CHUNK); i * FILE_CHUNK < end; i++) parts.push(this.chunk(i))
    const startInFirst = offset - Math.floor(offset / FILE_CHUNK) * FILE_CHUNK
    return Buffer.concat(parts).subarray(startInFirst, startInFirst + (end - offset))
  }

  /** Streams the whole plaintext chunk by chunk. */
  *chunksInOrder(): Generator<Buffer> {
    for (let i = 0; i < this.chunks; i++) yield this.chunk(i)
  }

  close(): void {
    closeSync(this.fd)
  }
}

export function readEncryptedFile(key: Buffer, path: string): Buffer {
  const r = new EncryptedFileReader(key, path)
  try {
    return Buffer.concat([...r.chunksInOrder()])
  } finally {
    r.close()
  }
}

// ---------- downloads in progress ----------
// A partial download is a list of independently sealed records ([u32 length][nonce][ct][tag]),
// one per received network chunk — so nothing is ever written to disk unencrypted.

export function sealRecord(key: Buffer, plain: Uint8Array): Buffer {
  const nonce = randomBytes(NONCE)
  const c = createCipheriv('aes-256-gcm', key, nonce)
  const body = Buffer.concat([c.update(plain), c.final()])
  const len = Buffer.alloc(4)
  len.writeUInt32BE(plain.length)
  return Buffer.concat([len, nonce, body, c.getAuthTag()])
}

/** Walks the records of a partial download, yielding the plaintext of each. */
export function* openRecords(key: Buffer, data: Buffer): Generator<Buffer> {
  let at = 0
  while (at + 4 <= data.length) {
    const len = data.readUInt32BE(at)
    const end = at + 4 + NONCE + len + TAG
    if (end > data.length) return // torn final write: ignore the incomplete record
    const nonce = data.subarray(at + 4, at + 4 + NONCE)
    const d = createDecipheriv('aes-256-gcm', key, nonce)
    d.setAuthTag(data.subarray(end - TAG, end))
    yield Buffer.concat([d.update(data.subarray(at + 4 + NONCE, end - TAG)), d.final()])
    at = end
  }
}

/** Plaintext bytes in a partial download, and the byte length of its complete records. */
export function recordsLength(data: Buffer): { plain: number; bytes: number } {
  let at = 0
  let plain = 0
  while (at + 4 <= data.length) {
    const len = data.readUInt32BE(at)
    const end = at + 4 + NONCE + len + TAG
    if (end > data.length) break
    plain += len
    at = end
  }
  return { plain, bytes: at }
}
