import { describe, expect, it } from 'vitest'
import { linkify } from './linkify'

describe('linkify', () => {
  it('finds http(s) links and leaves punctuation outside', () => {
    expect(linkify('see https://example.com/a?b=1, then http://x.org.')).toEqual([
      { text: 'see ' },
      { text: 'https://example.com/a?b=1', url: 'https://example.com/a?b=1' },
      { text: ', then ' },
      { text: 'http://x.org', url: 'http://x.org' },
      { text: '.' }
    ])
  })

  it('keeps balanced brackets and ignores other schemes', () => {
    expect(linkify('(https://en.wikipedia.org/wiki/Foo_(bar))')).toEqual([
      { text: '(' },
      { text: 'https://en.wikipedia.org/wiki/Foo_(bar)', url: 'https://en.wikipedia.org/wiki/Foo_(bar)' },
      { text: ')' }
    ])
    expect(linkify('file:///etc/passwd javascript:alert(1) ftp://x')).toEqual([{ text: 'file:///etc/passwd javascript:alert(1) ftp://x' }])
    expect(linkify('')).toEqual([])
  })
})
