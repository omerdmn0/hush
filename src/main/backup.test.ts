import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { applyStagedRestore, backupFileName, backupKeyFromPassword, extractBackup, markStagedRestoreReady, pruneBackups, readBackupHeader, STAGING, writeBackup } from './backup'
import { Avatars } from './avatars'
import { HushDb } from './db'
import { ImageStore } from './images'
import { Keyring, type OsProtector } from './keyring'
import { EncryptedFileWriter, fieldCipher, newDataKey, newKdfParams, readEncryptedFile } from './vault'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'hush-backup-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

/** Stands in for the OS keychain. */
const fakeOs = (available = true): OsProtector => ({
  available: async () => available,
  name: () => 'Test keychain',
  encrypt: async (s) => Buffer.from('os:' + s),
  decrypt: async (b) => b.toString().slice(3)
})

describe('Keyring', () => {
  it('protects the data key with the keychain or a password', async () => {
    const k = new Keyring(dir, fakeOs())
    expect(k.mode()).toBe('new')
    const key = await k.create()
    expect(k.mode()).toBe('os')
    expect((await k.unlockWithKeychain()).equals(key)).toBe(true)

    await k.protect(key, 'app password')
    expect(k.mode()).toBe('password')
    expect(k.unlockWithPassword('app password').equals(key)).toBe(true)
    expect(() => k.unlockWithPassword('nope')).toThrow()
    await expect(k.unlockWithKeychain()).rejects.toThrow()
  })

  it('refuses to store the key without a keychain unless there is a password', async () => {
    const k = new Keyring(dir, fakeOs(false))
    await expect(k.create()).rejects.toThrow(/password is required/)
    const key = await k.create('pw')
    expect(k.unlockWithPassword('pw').equals(key)).toBe(true)
  })
})

describe('backups', () => {
  const PEER = randomUUID()

  function makeData(): { key: Buffer; data: string; ids: string[] } {
    const key = newDataKey()
    const data = join(dir, 'data')
    mkdirSync(data)
    const db = new HushDb(join(data, 'hush.db'), fieldCipher(key))
    db.setSetting('selfId', 'me')
    db.setSecret('identityKey', 'PRIVATE')
    const ids = [randomUUID(), randomUUID()]
    db.insertMessage({ id: ids[0], authorId: PEER, seq: 1, body: 'gizli mesaj', sentAt: 1, status: 'read', image: null })
    db.insertMessage({ id: ids[1], authorId: PEER, seq: 2, body: '', sentAt: 2, status: 'read', image: { mime: 'image/png', size: 4, width: 1, height: 1, sha256: 'x' } })
    db.close()
    const store = new ImageStore(join(data, 'images'), key)
    store.saveOwn(ids[1], { mime: 'image/png', size: 4, width: 1, height: 1, sha256: 'x' }, Buffer.from('FULL'), Buffer.from('THUMB'))
    return { key, data, ids }
  }

  const source = (key: Buffer, data: string) => ({
    dataKey: key,
    dir: data,
    app: '0.2.0',
    snapshotDb: async (path: string) => {
      const db = new HushDb(join(data, 'hush.db'), fieldCipher(key))
      await db.snapshot(path)
      db.close()
    }
  })

  it('round-trips history, keys and images with the backup password', async () => {
    const { key, data, ids } = makeData()
    const out = join(dir, 'b.hushbackup')
    const r = await writeBackup(source(key, data), backupKeyFromPassword('backup pw'), true, out)
    expect(r.files).toBe(4) // key, db, thumb, full
    expect(readBackupHeader(out).header.attachments).toBe(true)

    expect(() => extractBackup(out, 'wrong', join(dir, 'x'))).toThrow(/Wrong backup password/)
    expect(existsSync(join(dir, 'x'))).toBe(false)

    const target = join(dir, 'restored')
    const { dataKey } = extractBackup(out, 'backup pw', target)
    expect(dataKey.equals(key)).toBe(true)
    const db = new HushDb(join(target, 'hush.db'), fieldCipher(dataKey))
    expect(db.getMessage(ids[0])?.body).toBe('gizli mesaj')
    expect(db.getSecret('identityKey')).toBe('PRIVATE')
    db.close()
    const store = new ImageStore(join(target, 'images'), dataKey)
    expect(store.readThumbBase64(ids[1])).toBe(Buffer.from('THUMB').toString('base64'))
    expect(readEncryptedFile(dataKey, store.fullPath(ids[1], { mime: 'image/png', size: 4, sha256: 'x' })).toString()).toBe('FULL')
  })

  it('leaves full images out unless asked (previews stay)', async () => {
    const { key, data, ids } = makeData()
    const out = join(dir, 'small.hushbackup')
    await writeBackup(source(key, data), backupKeyFromPassword('pw'), false, out)
    const target = join(dir, 'r')
    extractBackup(out, 'pw', target)
    expect(readdirSync(join(target, 'images'))).toEqual([`${ids[1]}.thumb.webp`])
  })

  it('refuses entries that would land outside the restore folder', () => {
    const bk = backupKeyFromPassword('pw', newKdfParams())
    const json = Buffer.from(JSON.stringify({ kdf: bk.kdf, created: 0, app: 'x', attachments: false }))
    const len = Buffer.alloc(4)
    len.writeUInt32BE(json.length)
    const file = join(dir, 'evil.hushbackup')
    const w = new EncryptedFileWriter(bk.key, file, Buffer.concat([Buffer.from('HUSHBAK1'), len, json]))
    const name = Buffer.from('../escaped.txt')
    const h = Buffer.alloc(2 + name.length + 8)
    h.writeUInt16BE(name.length, 0)
    name.copy(h, 2)
    h.writeBigUInt64BE(3n, 2 + name.length)
    w.write(Buffer.concat([h, Buffer.from('bad')]))
    w.close()
    expect(() => extractBackup(file, 'pw', join(dir, 'target'))).toThrow(/damaged/)
    expect(existsSync(join(dir, 'escaped.txt'))).toBe(false)
  })

  it('names automatic backups by date and keeps the newest three', () => {
    for (const d of ['2026-10-01', '2026-10-08', '2026-10-15', '2026-10-22']) writeFileSync(join(dir, `Hush-backup-${d}.hushbackup`), 'x')
    writeFileSync(join(dir, 'unrelated.txt'), 'x')
    expect(backupFileName(new Date('2026-10-22T10:00:00Z'), dir)).toBe('Hush-backup-2026-10-22-2.hushbackup')
    pruneBackups(dir, 3)
    expect(readdirSync(dir).sort()).toEqual([
      'Hush-backup-2026-10-08.hushbackup',
      'Hush-backup-2026-10-15.hushbackup',
      'Hush-backup-2026-10-22.hushbackup',
      'unrelated.txt'
    ])
  })
})

describe('applying a restore at startup', () => {
  const setup = (): string => {
    const data = join(dir, 'data')
    mkdirSync(join(data, 'images'), { recursive: true })
    writeFileSync(join(data, 'hush.db'), 'current db')
    writeFileSync(join(data, 'hush.db-wal'), 'current wal')
    writeFileSync(join(data, 'avatar-peer.img'), 'current avatar')
    writeFileSync(join(data, 'images', 'old.png'), 'old')
    writeFileSync(join(data, 'settings-unrelated.json'), 'kept')
    const st = join(data, STAGING)
    mkdirSync(join(st, 'images'), { recursive: true })
    writeFileSync(join(st, 'hush.db'), 'restored db')
    writeFileSync(join(st, 'vault.json'), 'restored vault')
    writeFileSync(join(st, 'images', 'new.png'), 'new')
    return data
  }

  it('replaces the data with the staged backup', () => {
    const data = setup()
    markStagedRestoreReady(data)
    expect(applyStagedRestore(data)).toBe(true)
    expect(readFileSync(join(data, 'hush.db'), 'utf8')).toBe('restored db')
    expect(readFileSync(join(data, 'vault.json'), 'utf8')).toBe('restored vault')
    expect(readdirSync(join(data, 'images'))).toEqual(['new.png'])
    for (const gone of ['hush.db-wal', 'avatar-peer.img', STAGING]) expect(existsSync(join(data, gone))).toBe(false)
    expect(existsSync(join(data, 'settings-unrelated.json'))).toBe(true)
    expect(applyStagedRestore(data)).toBe(false)
  })

  it('finishes a swap that was interrupted halfway', () => {
    const data = setup()
    const st = join(data, STAGING)
    writeFileSync(join(st, '.applying'), '')
    // Crash after the database was already moved in:
    rmSync(join(data, 'hush.db'))
    renameSync(join(st, 'hush.db'), join(data, 'hush.db'))
    expect(applyStagedRestore(data)).toBe(true)
    expect(readFileSync(join(data, 'hush.db'), 'utf8')).toBe('restored db')
    expect(readFileSync(join(data, 'vault.json'), 'utf8')).toBe('restored vault')
  })

  it('throws away an unpack that never finished', () => {
    const data = setup()
    expect(applyStagedRestore(data)).toBe(false)
    expect(readFileSync(join(data, 'hush.db'), 'utf8')).toBe('current db')
    expect(existsSync(join(data, STAGING))).toBe(false)
  })
})

describe('upgrading data stored before encryption', () => {
  it('encrypts existing images and avatars in place and drops old plain partial downloads', () => {
    const key = newDataKey()
    const imgDir = join(dir, 'images')
    mkdirSync(imgDir)
    const id = randomUUID()
    writeFileSync(join(imgDir, `${id}.png`), 'PLAIN FULL IMAGE')
    writeFileSync(join(imgDir, `${id}.thumb.webp`), 'PLAIN THUMB')
    writeFileSync(join(imgDir, `${randomUUID()}.part`), 'PLAIN HALF DOWNLOAD')
    writeFileSync(join(dir, 'avatar-self.img'), 'PLAIN AVATAR')

    const store = new ImageStore(imgDir, key)
    expect(store.encryptExisting()).toBe(2)
    expect(store.encryptExisting()).toBe(0) // idempotent
    expect(readdirSync(imgDir).sort()).toEqual([`${id}.png`, `${id}.thumb.webp`].sort())
    expect(readFileSync(join(imgDir, `${id}.png`)).toString('latin1')).not.toContain('PLAIN')
    expect(readEncryptedFile(key, join(imgDir, `${id}.png`)).toString()).toBe('PLAIN FULL IMAGE')

    const avatars = new Avatars(dir, key)
    avatars.encryptExisting()
    expect(readFileSync(join(dir, 'avatar-self.img')).toString('latin1')).not.toContain('PLAIN')
    expect(avatars.readForDisplay('self')?.toString()).toBe('PLAIN AVATAR')
  })
})

describe('backup edge cases', () => {
  it('prunes the oldest backups of a day, not the numbered newer ones', () => {
    const names = ['', '-2', '-3', '-10'].map((n) => `Hush-backup-2026-01-01${n}.hushbackup`)
    for (const n of names) writeFileSync(join(dir, n), 'x')
    pruneBackups(dir, 3)
    expect(readdirSync(dir).sort()).toEqual([names[3], names[1], names[2]].sort())
  })

  it('a restore replaces all attachments, even when the backup holds none', () => {
    mkdirSync(join(dir, 'images'))
    writeFileSync(join(dir, 'images', 'old.png'), 'encrypted with the old key')
    mkdirSync(join(dir, STAGING))
    writeFileSync(join(dir, STAGING, 'hush.db'), 'db')
    markStagedRestoreReady(dir)
    expect(applyStagedRestore(dir)).toBe(true)
    expect(existsSync(join(dir, 'images', 'old.png'))).toBe(false)
  })

  async function smallBackup(): Promise<string> {
    const file = join(dir, 'b.hushbackup')
    const data = join(dir, 'data')
    mkdirSync(data)
    writeFileSync(join(data, 'avatar-self.img'), Buffer.alloc(300_000, 7))
    const source = { snapshotDb: async (p: string) => writeFileSync(p, 'db'), dataKey: newDataKey(), dir: data, app: '1.0.0' }
    await writeBackup(source, backupKeyFromPassword('password1'), false, file)
    return file
  }

  it('explains a truncated backup in plain words', async () => {
    const file = await smallBackup()
    const whole = readFileSync(file)
    writeFileSync(file, whole.subarray(0, whole.length - 5000))
    expect(() => extractBackup(file, 'password1', join(dir, 'out'))).toThrow(/damaged/)
  })

  it('explains a backup with a broken header in plain words', () => {
    const file = join(dir, 'bad.hushbackup')
    const len = Buffer.alloc(4)
    len.writeUInt32BE(5)
    writeFileSync(file, Buffer.concat([Buffer.from('HUSHBAK1'), len, Buffer.from('{nope')]))
    expect(() => extractBackup(file, 'password1', join(dir, 'out'))).toThrow(/damaged/)
  })
})
