import { describe, expect, it } from 'vitest'
import { cleanFileName, isRiskyFile } from './files'
import { isFileName } from './protocol'

describe('file names', () => {
  it('sees through trailing dots and spaces, which Windows drops when saving', () => {
    for (const name of ['setup.exe', 'SETUP.EXE', 'setup.exe.', 'setup.exe...', 'setup.exe. .']) expect(isRiskyFile(name)).toBe(true)
    for (const name of ['notes.txt', 'exe', 'archive.tar.gz']) expect(isRiskyFile(name)).toBe(false)
  })

  it('always produces a name the other app accepts', () => {
    const awkward = ['a'.repeat(300), `${'a'.repeat(300)}.pdf`, `a.${'b'.repeat(300)}`, `${'a '.repeat(150)}.pdf`, `${'a'.repeat(250)}     z.pdf`, ' . ', '\u0001']
    for (const raw of awkward) expect(isFileName(cleanFileName(raw)), raw.slice(0, 20)).toBe(true)
    expect(cleanFileName(`${'a'.repeat(300)}.pdf`).endsWith('.pdf')).toBe(true)
  })
})
