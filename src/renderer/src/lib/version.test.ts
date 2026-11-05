import { describe, expect, it } from 'vitest'
import { isNewer } from './version'

describe('isNewer', () => {
  it('compares versions numerically', () => {
    expect(isNewer('0.10.0', '0.9.3')).toBe(true)
    expect(isNewer('0.2.0', '0.2.0')).toBe(false)
    expect(isNewer('0.1.9', '0.2.0')).toBe(false)
    expect(isNewer('1.0.0-beta.1', '0.9.0')).toBe(true)
  })
})
