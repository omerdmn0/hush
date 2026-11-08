import { describe, expect, it, vi } from 'vitest'
import { getTransfer, setTransfer, subscribeTransfer } from './transferStore'
import type { ImageTransfer } from '../../../shared/types'

const update = (id: string, progress: number): ImageTransfer => ({ id, direction: 'down', state: 'active', progress })

describe('transfer store', () => {
  it('notifies only the bubble whose file changed', () => {
    const [a, b] = [vi.fn(), vi.fn()]
    const stopA = subscribeTransfer('a', a)
    const stopB = subscribeTransfer('b', b)
    setTransfer(update('a', 0.5))
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).not.toHaveBeenCalled()
    expect(getTransfer('a')?.progress).toBe(0.5)
    stopA()
    stopB()
  })

  it('stops notifying after unsubscribing', () => {
    const notify = vi.fn()
    subscribeTransfer('c', notify)()
    setTransfer(update('c', 1))
    expect(notify).not.toHaveBeenCalled()
  })
})
