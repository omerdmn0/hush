import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImageStore } from './images'
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
})
