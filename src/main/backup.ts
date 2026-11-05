import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, join, normalize, sep } from 'node:path'
import { deriveKey, EncryptedFileReader, EncryptedFileWriter, newKdfParams, type KdfParams } from './vault'

/**
 * Backup file (".hushbackup"):
 *   "HUSHBAK1" | u32 header length | JSON header { kdf, created, app, attachments }
 *   then an encrypted stream (see vault.ts) under a key derived from the backup password,
 *   holding entries: u16 name length | name | u64 size | bytes.
 * Entries: hush.db (a consistent snapshot), vault.key (the data key), images/…, avatar-*.img.
 * Files inside are already encrypted with the data key; the backup password protects that key.
 */

const MAGIC = Buffer.from('HUSHBAK1')
const COPY_CHUNK = 1024 * 1024

export interface BackupHeader {
  kdf: KdfParams
  created: number
  app: string
  attachments: boolean
}

export interface BackupSource {
  /** Writes a consistent copy of the database to `path`. */
  snapshotDb: (path: string) => Promise<void>
  dataKey: Buffer
  /** App data folder (images/ and avatars live here). */
  dir: string
  app: string
}

/** A key for backups derived from the backup password (kept for automatic backups). */
export interface BackupKey {
  kdf: KdfParams
  key: Buffer
}

export function backupKeyFromPassword(password: string, kdf: KdfParams = newKdfParams()): BackupKey {
  return { kdf, key: deriveKey(password, kdf) }
}

/** Previews and voice notes (small) are always included; full pictures and files only if asked. */
const isAlwaysIncluded = (name: string): boolean => name.endsWith('.thumb.webp') || name.endsWith('.voice')

export async function writeBackup(src: BackupSource, bk: BackupKey, includeAttachments: boolean, out: string): Promise<{ bytes: number; files: number }> {
  const tmpDb = out + '.db-tmp'
  const tmpOut = out + '.tmp'
  await src.snapshotDb(tmpDb)
  try {
    const header: BackupHeader = { kdf: bk.kdf, created: Date.now(), app: src.app, attachments: includeAttachments }
    const json = Buffer.from(JSON.stringify(header))
    const len = Buffer.alloc(4)
    len.writeUInt32BE(json.length)
    const w = new EncryptedFileWriter(bk.key, tmpOut, Buffer.concat([MAGIC, len, json]))
    let files = 0
    const addBuffer = (name: string, data: Uint8Array): void => {
      w.write(entryHeader(name, data.length))
      w.write(data)
      files++
    }
    const addFile = async (name: string, path: string): Promise<void> => {
      const size = statSync(path).size
      w.write(entryHeader(name, size))
      const fd = openSync(path, 'r')
      try {
        const buf = Buffer.alloc(COPY_CHUNK)
        for (let at = 0; at < size; ) {
          const n = readSync(fd, buf, 0, Math.min(COPY_CHUNK, size - at), at)
          w.write(buf.subarray(0, n))
          at += n
          await tick() // keep chat and calls responsive during a large backup
        }
      } finally {
        closeSync(fd)
      }
      files++
    }
    addBuffer('vault.key', src.dataKey)
    await addFile('hush.db', tmpDb)
    for (const name of ['avatar-self.img', 'avatar-peer.img']) {
      if (exists(join(src.dir, name))) await addFile(name, join(src.dir, name))
    }
    const images = join(src.dir, 'images')
    if (exists(images)) {
      for (const name of readdirSync(images)) {
        if (name.endsWith('.part') || name.endsWith('.tmp')) continue
        if (!includeAttachments && !isAlwaysIncluded(name)) continue
        await addFile(`images/${name}`, join(images, name))
      }
    }
    w.close()
    renameSync(tmpOut, out)
    return { bytes: statSync(out).size, files }
  } catch (e) {
    rmSync(tmpOut, { force: true })
    throw e
  } finally {
    rmSync(tmpDb, { force: true })
  }
}

const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

function entryHeader(name: string, size: number): Buffer {
  const n = Buffer.from(name, 'utf8')
  const h = Buffer.alloc(2 + n.length + 8)
  h.writeUInt16BE(n.length, 0)
  n.copy(h, 2)
  h.writeBigUInt64BE(BigInt(size), 2 + n.length)
  return h
}

const exists = (p: string): boolean => {
  try {
    statSync(p)
    return true
  } catch {
    return false
  }
}

export function readBackupHeader(file: string): { header: BackupHeader; offset: number } {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(12)
    readSync(fd, head, 0, 12, 0)
    if (!head.subarray(0, 8).equals(MAGIC)) throw new Error('This is not a Hush backup file.')
    const len = head.readUInt32BE(8)
    if (len > 64 * 1024) throw new Error('This backup file is damaged.')
    const json = Buffer.alloc(len)
    readSync(fd, json, 0, len, 12)
    return { header: JSON.parse(json.toString('utf8')) as BackupHeader, offset: 12 + len }
  } finally {
    closeSync(fd)
  }
}

/**
 * Decrypts a backup into `targetDir` (which should be empty). Throws "wrong password" on the first
 * chunk if the password is wrong, and refuses entry names that would escape the folder.
 * Returns the data key stored in the backup.
 */
export function extractBackup(file: string, password: string, targetDir: string): { dataKey: Buffer; header: BackupHeader; files: number } {
  const { header, offset } = readBackupHeader(file)
  const key = deriveKey(password, header.kdf)
  let reader: EncryptedFileReader
  try {
    reader = new EncryptedFileReader(key, file, offset)
    reader.read(0, 1) // authenticates the first chunk
  } catch {
    throw new Error('Wrong backup password (or the file is damaged).')
  }
  mkdirSync(targetDir, { recursive: true })
  let dataKey: Buffer | null = null
  let files = 0
  let pos = 0
  const take = (n: number): Buffer => {
    const b = reader.read(pos, n)
    if (b.length !== n) throw new Error('This backup file is damaged.')
    pos += n
    return b
  }
  try {
    while (pos < reader.size) {
      const nameLen = take(2).readUInt16BE(0)
      const name = take(nameLen).toString('utf8')
      const size = Number(take(8).readBigUInt64BE(0))
      const dest = normalize(join(targetDir, name))
      if (!dest.startsWith(normalize(targetDir) + sep) || name.includes('..')) throw new Error('This backup file is damaged.')
      if (name === 'vault.key') {
        dataKey = take(size)
      } else {
        mkdirSync(dirname(dest), { recursive: true })
        const fd = openSync(dest, 'w')
        try {
          for (let left = size; left > 0; ) {
            const piece = take(Math.min(COPY_CHUNK, left))
            writeSync(fd, piece)
            left -= piece.length
          }
        } finally {
          closeSync(fd)
        }
      }
      files++
    }
  } finally {
    reader.close()
  }
  if (!dataKey) throw new Error('This backup file is damaged (no key).')
  return { dataKey, header, files }
}

/** Keeps the newest `keep` automatic backups in `folder`. */
export function pruneBackups(folder: string, keep: number): void {
  const ours = readdirSync(folder)
    .filter((n) => /^Hush-backup-\d{4}-\d{2}-\d{2}(-\d+)?\.hushbackup$/.test(n))
    .sort()
  for (const name of ours.slice(0, Math.max(0, ours.length - keep))) rmSync(join(folder, name), { force: true })
}

export function backupFileName(date: Date, folder: string): string {
  const base = `Hush-backup-${date.toISOString().slice(0, 10)}`
  let name = `${base}.hushbackup`
  for (let i = 2; exists(join(folder, name)); i++) name = `${base}-${i}.hushbackup`
  return name
}

// ---------- restoring ----------
// A restore is unpacked into <data>/restore-staging while Hush runs, then swapped in at the next
// start, before anything is opened. Markers make the swap safe to resume after a crash:
//   .ready     unpacked completely; nothing replaced yet
//   .applying  replacing in progress (current files already cleared)

export const STAGING = 'restore-staging'
/** Files of the current data that a restore replaces even if the backup doesn't contain them. */
const REPLACED = ['hush.db-wal', 'hush.db-shm', 'avatar-self.img', 'avatar-peer.img']

export function markStagedRestoreReady(dir: string): void {
  writeFileSync(join(dir, STAGING, '.ready'), '')
}

/** Swaps a staged restore into place. Returns true if one was applied. */
export function applyStagedRestore(dir: string): boolean {
  const staged = join(dir, STAGING)
  if (!existsSync(staged)) return false
  if (existsSync(join(staged, '.ready'))) {
    for (const name of REPLACED) rmSync(join(dir, name), { force: true })
    renameSync(join(staged, '.ready'), join(staged, '.applying'))
  }
  if (!existsSync(join(staged, '.applying'))) {
    rmSync(staged, { recursive: true, force: true }) // an unfinished unpack: discard it
    return false
  }
  for (const name of readdirSync(staged)) {
    if (name === '.applying') continue
    rmSync(join(dir, name), { recursive: true, force: true })
    renameSync(join(staged, name), join(dir, name))
  }
  rmSync(staged, { recursive: true, force: true })
  return true
}
