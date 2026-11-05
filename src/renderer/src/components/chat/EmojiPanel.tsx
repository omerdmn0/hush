import { useEffect, useRef, type ReactNode } from 'react'

// emoji-mart themed with Hush tokens. Uses the system's native emoji font and bundled data,
// so it never downloads anything (the CSP would block it anyway).
const THEME: Record<string, string> = {
  '--rgb-accent': '0, 229, 255',
  '--rgb-background': '28, 24, 40',
  '--rgb-color': '236, 234, 244',
  '--rgb-input': '10, 9, 16',
  '--color-border': 'rgba(42, 36, 64, 1)',
  '--color-border-over': 'rgba(110, 100, 145, 1)',
  '--border-radius': '2px',
  '--font-family': '"Exo 2 Variable", system-ui, sans-serif',
  '--shadow': 'none'
}

export function EmojiPanel({ onPick }: { onPick: (emoji: string) => void }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const pick = useRef(onPick)
  pick.current = onPick

  useEffect(() => {
    let cancelled = false
    let picker: HTMLElement | null = null
    // Loaded on first open to keep startup fast.
    void Promise.all([import('emoji-mart'), import('@emoji-mart/data')]).then(([{ Picker }, data]) => {
      if (cancelled || !host.current) return
      picker = new Picker({
        data: data.default,
        set: 'native',
        theme: 'dark',
        locale: 'en',
        previewPosition: 'none',
        skinTonePosition: 'search',
        maxFrequentRows: 2,
        autoFocus: true,
        onEmojiSelect: (e: { native: string }) => pick.current(e.native)
      }) as unknown as HTMLElement
      for (const [k, v] of Object.entries(THEME)) picker.style.setProperty(k, v)
      host.current.replaceChildren(picker)
    })
    return () => {
      cancelled = true
      picker?.remove()
    }
  }, [])

  return (
    <div ref={host} className="grid h-[435px] w-[352px] place-items-center">
      <span className="label">Loading emoji…</span>
    </div>
  )
}
