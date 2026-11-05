/** A piece of message text: plain, or a web link. */
export interface Segment {
  text: string
  url?: string
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi

/** Splits text into plain parts and http(s) links. Trailing punctuation stays outside the link. */
export function linkify(text: string): Segment[] {
  const out: Segment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0]
    while (/[.,;:!?)\]}'"]$/.test(url)) {
      // Keep a closing bracket that belongs to the link, as in …/Foo_(bar)
      const close = url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) >= (url.match(/\)/g)?.length ?? 0)
      if (close) break
      url = url.slice(0, -1)
    }
    const start = m.index
    if (start > last) out.push({ text: text.slice(last, start) })
    out.push({ text: url, url })
    last = start + url.length
  }
  if (last < text.length) out.push({ text: text.slice(last) })
  return out
}
