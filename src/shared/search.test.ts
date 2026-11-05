import { describe, expect, it } from 'vitest'
import { fold, matchesAll, queryTerms, snippet } from './search'

const finds = (text: string, query: string): boolean => matchesAll(fold(text).text, queryTerms(query))

describe('search matching', () => {
  it('ignores case and accents, including Turkish letters', () => {
    expect(finds('Şeker aldın mı?', 'seker')).toBe(true)
    expect(finds('İstanbul’a gidiyoruz', 'istanbul')).toBe(true)
    expect(finds('Hava ılık', 'ILIK')).toBe(true)
    expect(finds('Çok güzel, öğretmen', 'cok guzel ogretmen')).toBe(true)
    expect(finds('Café', 'cafe')).toBe(true)
  })

  it('needs every word, in any order', () => {
    expect(finds('dinner at eight tonight', 'tonight dinner')).toBe(true)
    expect(finds('dinner at eight', 'dinner lunch')).toBe(false)
    expect(queryTerms('   ')).toEqual([])
    expect(finds('anything', '  ')).toBe(false)
  })
})

describe('snippet', () => {
  it('highlights matches in the original spelling', () => {
    const s = snippet('Yarın İstanbul’da şekerci açılıyor', queryTerms('istanbul seker'))
    expect(s.parts.filter((p) => p.hit).map((p) => p.text)).toEqual(['İstanbul', 'şeker'])
    expect(s.parts.map((p) => p.text).join('')).toBe('Yarın İstanbul’da şekerci açılıyor')
    expect([s.cutStart, s.cutEnd]).toEqual([false, false])
  })

  it('cuts long text around the first match', () => {
    const text = 'a'.repeat(300) + ' needle ' + 'b'.repeat(300)
    const s = snippet(text, queryTerms('needle'), 20)
    expect(s.cutStart && s.cutEnd).toBe(true)
    expect(s.parts.find((p) => p.hit)?.text).toBe('needle')
    expect(s.parts.map((p) => p.text).join('').length).toBeLessThanOrEqual(80)
  })

  it('handles emoji and surrogate pairs around a match', () => {
    const s = snippet('🔥🔥 Çay 🔥', queryTerms('cay'))
    expect(s.parts.find((p) => p.hit)?.text).toBe('Çay')
  })
})
