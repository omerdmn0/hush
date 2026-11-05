const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const pad = (n: number): string => String(n).padStart(2, '0')

/** 24-hour clock time, e.g. "21:04". */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** Local midnight of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

/** Calendar-day difference (DST-safe): 0 = same day, 1 = yesterday. */
function daysBetween(earlier: number, later: number): number {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86_400_000)
}

/** Date separator label: "Today", "Yesterday" or "Tue 03.11.2026" (shown uppercase by CSS). */
export function dayLabel(ts: number, now: number = Date.now()): string {
  const diff = daysBetween(ts, now)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  const d = new Date(ts)
  return `${WEEKDAYS[d.getDay()]} ${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`
}

/** "Last seen" label: "13:11" today, "yesterday 22:40", otherwise "03.11 21:04". */
export function formatLastSeen(ts: number, now: number = Date.now()): string {
  const diff = daysBetween(ts, now)
  if (diff === 0) return formatTime(ts)
  if (diff === 1) return `yesterday ${formatTime(ts)}`
  const d = new Date(ts)
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${formatTime(ts)}`
}

/** Full timestamp for tooltips, e.g. "Tuesday, 3 November 2026 at 21:04". */
export function fullDateTime(ts: number): string {
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'full', timeStyle: 'short', hourCycle: 'h23' }).format(ts)
}

/** First letter of a name for avatars, locale-aware (so "ömer" → "Ö", "irmak" → "İ" in Turkish). */
export function initial(name: string): string {
  const first = [...name.trim()][0] ?? '?'
  return first.toLocaleUpperCase()
}
