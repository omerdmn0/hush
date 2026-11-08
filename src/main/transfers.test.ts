import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import type { HushDb } from './db'
import type { ImageStore } from './images'
import type { PeerLink } from './link'
import { Transfers } from './transfers'

describe('Transfers', () => {
  it('is no longer busy after a stored file turns out to be unreadable', async () => {
    const link = Object.assign(new EventEmitter(), { send: vi.fn(async () => true), sendBinary: vi.fn(async () => true) })
    const image = { size: 10, sha256: 'x', mime: 'image/png', width: 1, height: 1 }
    const db = { getMessage: () => ({ image }) } as unknown as HushDb
    const store = {
      hasFull: () => true,
      readChunk: () => {
        throw new Error('unreadable')
      }
    } as unknown as ImageStore
    const emit = vi.fn()
    const transfers = new Transfers(db, store, link as unknown as PeerLink, emit)

    transfers.onFrame({ t: 'blob-req', id: 'a', offset: 0 })
    await vi.waitFor(() => expect(link.send).toHaveBeenCalledWith({ t: 'blob-err', id: 'a' }))
    expect(transfers.busy).toBe(false)
    expect(emit).toHaveBeenCalledWith({ type: 'transfer', transfer: expect.objectContaining({ id: 'a', state: 'failed' }) })
    transfers.dispose()
  })
})
