import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImageStore, sha256 } from './images'
import { newDataKey } from './vault'

let dir: string
beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'hush-images-'))))
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('ImageStore', () => {
  it('leaves nothing behind when the source file can’t be read', async () => {
    const store = new ImageStore(dir, newDataKey())
    await expect(store.importFile(randomUUID(), join(dir, 'gone.bin'), 1000)).rejects.toThrow()
    expect(readdirSync(dir)).toEqual([])
  })

  it('clears temporary files left by a crash, and nothing else', () => {
    for (const name of ['a.file.tmp', 'b.part.tmp', 'c.file', 'd.part']) writeFileSync(join(dir, name), 'x')
    new ImageStore(dir, newDataKey())
    expect(readdirSync(dir).sort()).toEqual(['c.file', 'd.part'])
  })

  it('treats a finished download it can’t move into place as failed', async () => {
    const store = new ImageStore(dir, newDataKey())
    const id = randomUUID()
    const data = Buffer.from('some file')
    const meta = { size: data.length, sha256: sha256(data), mime: 'text/plain', file: 'file' as const }
    expect(store.appendPart(id, 0, data, meta)).toBe(data.length)
    mkdirSync(store.fullPath(id, meta)) // a directory in the way makes the rename fail

    await expect(store.finalize(id, meta)).resolves.toBe(false)
    expect(readdirSync(dir)).toEqual([`${id}.file`])
    expect(store.partSize(id)).toBe(0)
  })
})
