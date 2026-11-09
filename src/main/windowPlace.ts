export const MIN_WIDTH = 880
export const MIN_HEIGHT = 560
/** At least this much of the window's top edge must be on a screen, so it can be grabbed. */
const GRABBABLE_PX = 100

interface Area {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowPlace extends Area {
  maximized: boolean
}

/**
 * Where to open the window, from what was saved last time. Screens come and go, so the position
 * is only kept if the window would still be reachable; otherwise the system chooses one.
 */
export function restorePlace(saved: unknown, screens: Area[]): { bounds: Partial<Area> & { width: number; height: number }; maximized: boolean } | null {
  const s = saved as Partial<WindowPlace> | null | undefined
  if (!s || ![s.x, s.y, s.width, s.height].every(Number.isSafeInteger)) return null
  const { x, y } = s as Area
  const width = Math.min(Math.max(s.width!, MIN_WIDTH), Math.max(...screens.map((a) => a.width), MIN_WIDTH))
  const height = Math.min(Math.max(s.height!, MIN_HEIGHT), Math.max(...screens.map((a) => a.height), MIN_HEIGHT))
  const reachable = screens.some((a) => y >= a.y && y < a.y + a.height && Math.min(x + width, a.x + a.width) - Math.max(x, a.x) >= GRABBABLE_PX)
  return { bounds: reachable ? { x, y, width, height } : { width, height }, maximized: s.maximized === true }
}
