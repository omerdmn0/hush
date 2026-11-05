import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  deriveKey,
  EncryptedFileReader,
  EncryptedFileWriter,
  fieldCipher,
  FILE_CHUNK,
  newDataKey,
  newKdfParams,
  openRecords,
  readEncryptedFile,
  recordsLength,
  sealRecord,
  unwrapKey,
  wrapKey,
  writeEncryptedFile
} from './vault'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'hush-vault-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('field encryption', () => {
  it('round-trips text (incl. Turkish and emoji) and hides it', () => {
    const c = fieldCipher(newDataKey())
    const sealed = c.seal('Gizli mesaj: ğüşıöç 🌙')
    expect(sealed.startsWith('enc1:')).toBe(true)
    expect(sealed).not.toContain('Gizli')
    expect(c.open(sealed)).toBe('Gizli mesaj: ğüşıöç 🌙')
    expect(c.seal('')).toBe('')
    expect(c.open('legacy plaintext')).toBe('legacy plaintext')
  })

  it('refuses tampered values and the wrong key', () => {
    const key = newDataKey()
    const sealed = fieldCipher(key).seal('secret')
    const raw = Buffer.from(sealed.slice(5), 'base64')
    raw[14] ^= 1
    expect(() => fieldCipher(key).open('enc1:' + raw.toString('base64'))).toThrow()
    expect(() => fieldCipher(newDataKey()).open(sealed)).toThrow()
  })
})

describe('key wrapping', () => {
  it('unwraps only with the right password', () => {
    const key = newDataKey()
    const kdf = newKdfParams()
    const wrapped = wrapKey(key, deriveKey('correct horse', kdf))
    expect(unwrapKey(wrapped, deriveKey('correct horse', kdf)).equals(key)).toBe(true)
    expect(() => unwrapKey(wrapped, deriveKey('wrong horse', kdf))).toThrow()
  })
})

describe('file encryption', () => {
  const sizes = [0, 1, FILE_CHUNK - 1, FILE_CHUNK, FILE_CHUNK + 1, 3 * FILE_CHUNK + 777]

  it.each(sizes)('round-trips %i bytes and supports random access', (n) => {
    const key = newDataKey()
    const data = randomBytes(n)
    const file = join(dir, 'f.bin')
    writeEncryptedFile(key, file, data)
    // The plaintext doesn't appear in the file (only meaningful for inputs long enough not to match by chance).
    if (n >= 16) expect(readFileSync(file).includes(data.subarray(0, 32))).toBe(false)
    expect(readEncryptedFile(key, file).equals(data)).toBe(true)
    const r = new EncryptedFileReader(key, file)
    expect(r.size).toBe(n)
    if (n > 10) expect(r.read(n - 10, 50).equals(data.subarray(n - 10))).toBe(true)
    if (n > FILE_CHUNK + 5) expect(r.read(FILE_CHUNK - 3, 8).equals(data.subarray(FILE_CHUNK - 3, FILE_CHUNK + 5))).toBe(true)
    r.close()
  })

  it('streams many small writes into the same result', () => {
    const key = newDataKey()
    const data = randomBytes(2 * FILE_CHUNK + 1234)
    const w = new EncryptedFileWriter(key, join(dir, 's.bin'))
    for (let i = 0; i < data.length; i += 1000) w.write(data.subarray(i, i + 1000))
    w.close()
    expect(readEncryptedFile(key, join(dir, 's.bin')).equals(data)).toBe(true)
  })

  it('detects tampering and a dropped final chunk', () => {
    const key = newDataKey()
    const data = randomBytes(2 * FILE_CHUNK + 50)
    const file = join(dir, 't.bin')
    writeEncryptedFile(key, file, data)
    const raw = readFileSync(file)
    const flipped = Buffer.from(raw)
    flipped[200] ^= 1
    writeFileSync(join(dir, 'x.bin'), flipped)
    expect(() => readEncryptedFile(key, join(dir, 'x.bin'))).toThrow()
    // Drop the last chunk: the new final chunk wasn't sealed as "last" → refused.
    writeFileSync(join(dir, 'y.bin'), raw.subarray(0, 20 + 2 * (FILE_CHUNK + 16)))
    expect(() => readEncryptedFile(key, join(dir, 'y.bin'))).toThrow()
  })
})

describe('partial-download records', () => {
  it('stores pieces encrypted and ignores a torn final write', () => {
    const key = newDataKey()
    const pieces = [randomBytes(1000), randomBytes(5), randomBytes(4096)]
    const blob = Buffer.concat(pieces.map((p) => sealRecord(key, p)))
    expect(blob.includes(pieces[2].subarray(0, 32))).toBe(false)
    expect(Buffer.concat([...openRecords(key, blob)]).equals(Buffer.concat(pieces))).toBe(true)
    const torn = blob.subarray(0, blob.length - 7)
    expect(recordsLength(torn).plain).toBe(1005)
    expect(Buffer.concat([...openRecords(key, torn)]).equals(Buffer.concat(pieces.slice(0, 2)))).toBe(true)
  })
})
