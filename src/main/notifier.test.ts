import { afterEach, describe, expect, it, vi } from 'vitest'
import { Notifier } from './notifier'

vi.mock('electron', () => ({ Notification: { isSupported: () => false } }))

afterEach(() => {
  vi.useRealTimers()
})

describe('Notifier', () => {
  it('does nothing after Hush closed, even with a burst still waiting', () => {
    vi.useFakeTimers()
    // Reads the database in the real app, which is closed by now.
    const peerName = vi.fn(() => 'Mira')
    const n = new Notifier({ enabled: () => true, preview: () => false, focused: () => false, peerName, icon: '', onClick: () => {} })
    n.message({ text: 'hi', hasImage: false })
    n.dispose()
    vi.advanceTimersByTime(5000)
    expect(peerName).not.toHaveBeenCalled()
  })

  it('forgets waiting messages from a channel that was just erased', () => {
    vi.useFakeTimers()
    const peerName = vi.fn(() => 'Mira')
    const n = new Notifier({ enabled: () => true, preview: () => true, focused: () => false, peerName, icon: '', onClick: () => {} })
    n.message({ text: 'secret', hasImage: false, channel: 'c1' })
    n.dropChannel('c1')
    vi.advanceTimersByTime(5000)
    expect(peerName).not.toHaveBeenCalled()
  })

  it('still sends a waiting burst while Hush runs', () => {
    vi.useFakeTimers()
    const peerName = vi.fn(() => 'Mira')
    const n = new Notifier({ enabled: () => true, preview: () => false, focused: () => false, peerName, icon: '', onClick: () => {} })
    n.message({ text: 'hi', hasImage: false })
    vi.advanceTimersByTime(5000)
    expect(peerName).toHaveBeenCalledTimes(1)
  })
})
