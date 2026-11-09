/** The bytes a media element asked for ("Range: bytes=a-b"), or null to send the whole file. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  const m = /^bytes=(\d+)-(\d*)$/.exec(header ?? '')
  if (!m) return null
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  return start <= end ? { start, end } : null
}
