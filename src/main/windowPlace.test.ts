import { describe, expect, it } from 'vitest'
import { MIN_HEIGHT, MIN_WIDTH, restorePlace } from './windowPlace'

const laptop = { x: 0, y: 0, width: 1920, height: 1080 }
const external = { x: 1920, y: 0, width: 2560, height: 1440 }

describe('restorePlace', () => {
  it('reopens where the window was', () => {
    expect(restorePlace({ x: 100, y: 50, width: 1000, height: 700, maximized: false }, [laptop])).toEqual({ bounds: { x: 100, y: 50, width: 1000, height: 700 }, maximized: false })
  })

  it('remembers being maximized', () => {
    expect(restorePlace({ x: 0, y: 0, width: 1000, height: 700, maximized: true }, [laptop])?.maximized).toBe(true)
  })

  it('lets the system choose when the screen it was on is gone', () => {
    const saved = { x: 2500, y: 100, width: 1000, height: 700, maximized: false }
    expect(restorePlace(saved, [laptop, external])?.bounds).toMatchObject({ x: 2500, y: 100 })
    expect(restorePlace(saved, [laptop])?.bounds).toEqual({ width: 1000, height: 700 })
  })

  it('never opens with the title bar out of reach', () => {
    expect(restorePlace({ x: 100, y: -300, width: 1000, height: 700, maximized: false }, [laptop])?.bounds).toEqual({ width: 1000, height: 700 })
    expect(restorePlace({ x: 1900, y: 100, width: 1000, height: 700, maximized: false }, [laptop])?.bounds).toEqual({ width: 1000, height: 700 })
  })

  it('keeps the size between the minimum and the largest screen', () => {
    expect(restorePlace({ x: 0, y: 0, width: 100, height: 100, maximized: false }, [laptop])?.bounds).toMatchObject({ width: MIN_WIDTH, height: MIN_HEIGHT })
    expect(restorePlace({ x: 0, y: 0, width: 9000, height: 9000, maximized: false }, [laptop])?.bounds).toMatchObject({ width: 1920, height: 1080 })
  })

  it('ignores missing or damaged data', () => {
    for (const saved of [undefined, null, 'x', {}, { x: 'a', y: 0, width: 1, height: 1 }]) expect(restorePlace(saved, [laptop])).toBeNull()
  })
})
