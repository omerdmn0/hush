/**
 * Search matching, shared by the main process (finding) and the UI (highlighting).
 * Case- and accent-insensitive, with Turkish letters folded too: "seker" finds "Şeker",
 * "istanbul" finds "İstanbul", "ilik" finds "ılık".
 */

/** Folded text plus, for every folded character, where it came from in the original. */
export interface Folded {
  text: string
  map: number[]
}

export function fold(s: string): Folded {
  let text = ''
  const map: number[] = []
  let at = 0
  for (const ch of s) {
    const f = ch.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i')
    for (let i = 0; i < f.length; i++) map.push(at)
    text += f
    at += ch.length
  }
  map.push(at) // end position
  return { text, map }
}

/** The words of a query, folded; every one must appear in a message. */
export function queryTerms(query: string): string[] {
  return [...new Set(fold(query).text.split(/\s+/).filter(Boolean))]
}

export function matchesAll(foldedText: string, terms: readonly string[]): boolean {
  return terms.length > 0 && terms.every((t) => foldedText.includes(t))
}

export interface SnippetPart {
  text: string
  hit: boolean
}

/**
 * A short excerpt around the first match, split into plain and highlighted parts.
 * `cut` says whether text was left out before / after.
 */
export function snippet(text: string, terms: readonly string[], around = 60): { parts: SnippetPart[]; cutStart: boolean; cutEnd: boolean } {
  const f = fold(text)
  // Highlight ranges in the original text, merged.
  const ranges: [number, number][] = []
  for (const t of terms) {
    for (let i = f.text.indexOf(t); i >= 0; i = f.text.indexOf(t, i + 1)) ranges.push([f.map[i], f.map[i + t.length]])
  }
  ranges.sort((a, b) => a[0] - b[0])
  const merged: [number, number][] = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1])
    else merged.push([...r])
  }
  const first = merged[0]?.[0] ?? 0
  const start = Math.max(0, first - around)
  const end = Math.min(text.length, Math.max(first + around * 2, start + around * 3))
  const parts: SnippetPart[] = []
  let at = start
  for (const [a, b] of merged) {
    if (b <= start || a >= end) continue
    if (a > at) parts.push({ text: text.slice(at, a), hit: false })
    parts.push({ text: text.slice(Math.max(a, at), Math.min(b, end)), hit: true })
    at = Math.min(b, end)
  }
  if (at < end) parts.push({ text: text.slice(at, end), hit: false })
  return { parts, cutStart: start > 0, cutEnd: end < text.length }
}
