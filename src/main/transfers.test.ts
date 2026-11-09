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
    const db = { getMessage: () => ({ image }), getSetting: () => undefined } as unknown as HushDb
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

  it('reports a download as failed when the finished file can’t be put in place', async () => {
    const link = Object.assign(new EventEmitter(), { peer: {}, send: vi.fn(async () => true), sendBinary: vi.fn(async () => true) })
    const image = { size: 10, sha256: 'x', mime: 'image/png', width: 1, height: 1 }
    const db = { getMessage: () => ({ image }), getSetting: () => undefined } as unknown as HushDb
    const discardPart = vi.fn()
    const store = { hasFull: () => false, partSize: () => 10, finalize: vi.fn(async () => Promise.reject(new Error('locked'))), discardPart } as unknown as ImageStore
    const emit = vi.fn()
    const transfers = new Transfers(db, store, link as unknown as PeerLink, emit)

    transfers.want('a')
    await vi.waitFor(() => expect(emit).toHaveBeenCalledWith({ type: 'transfer', transfer: expect.objectContaining({ id: 'a', state: 'failed' }) }))
    expect(discardPart).toHaveBeenCalledWith('a')
    expect(transfers.busy).toBe(false)
    transfers.dispose()
  })

  it('never lets a cancelled send carry on as if it were the one that replaced it', async () => {
    // Chunks 1 (the old send's first) and 3 (the new send's second) wait until released.
    const gate = (): { promise: Promise<boolean>; resolve: (v: boolean) => void } => {
      let resolve = (_: boolean): void => {}
      const promise = new Promise<boolean>((r) => (resolve = r))
      return { promise, resolve }
    }
    const gates = [gate(), gate()]
    const sendBinary = vi.fn(async () => {
      const n = sendBinary.mock.calls.length
      return n === 1 ? gates[0].promise : n === 3 ? gates[1].promise : true
    })
    const link = Object.assign(new EventEmitter(), { peer: {}, send: vi.fn(async () => true), sendBinary })
    const image = { size: 3, sha256: 'x', mime: 'image/png', width: 1, height: 1 }
    const db = { getMessage: () => ({ image }), getSetting: () => undefined, setSetting: vi.fn() } as unknown as HushDb
    const store = { hasFull: () => true, readChunk: () => new Uint8Array(1) } as unknown as ImageStore
    const transfers = new Transfers(db, store, link as unknown as PeerLink, vi.fn(), 1)

    transfers.onFrame({ t: 'blob-req', id: 'a', offset: 0 })
    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalledTimes(1)) // the first send is stuck on its first chunk
    transfers.stop('a')
    transfers.retry('a')
    transfers.onFrame({ t: 'blob-req', id: 'a', offset: 0 })
    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalledTimes(3))
    gates[0].resolve(true)
    await new Promise((r) => setTimeout(r, 20))
    expect(sendBinary).toHaveBeenCalledTimes(3) // the old send woke up and stopped
    gates[1].resolve(true)
    await vi.waitFor(() => expect(sendBinary).toHaveBeenCalledTimes(4)) // the new one finishes
    await new Promise((r) => setTimeout(r, 20))
    expect(transfers.busy).toBe(false)
    transfers.dispose()
  })
})
