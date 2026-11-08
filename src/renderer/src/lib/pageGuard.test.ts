import { describe, expect, it } from 'vitest'
import { PageGuard } from './pageGuard'

describe('PageGuard', () => {
  it('lets only the newest switch land', () => {
    const g = new PageGuard()
    const first = g.beginSwitch()
    const second = g.beginSwitch()
    expect(first()).toBe(false)
    expect(second()).toBe(true)
  })

  it('keeps paging valid while a switch is only on its way', () => {
    const g = new PageGuard()
    const paging = g.watchList()
    g.beginSwitch()
    expect(paging()).toBe(true)
  })

  it('drops paging once a switch has replaced the list', () => {
    const g = new PageGuard()
    const paging = g.watchList()
    g.beginSwitch()
    g.landed()
    expect(paging()).toBe(false)
  })

  it('drops paging after going to another channel and back', () => {
    const g = new PageGuard()
    const pagingInA = g.watchList()
    g.landed() // to B
    g.landed() // back to A: same channel, but only its newest page is loaded now
    expect(pagingInA()).toBe(false)
  })

  it('accepts paging started after the switch landed', () => {
    const g = new PageGuard()
    g.landed()
    expect(g.watchList()()).toBe(true)
  })
})
