import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Mic, MicOff, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'

const hms = (s: number): string =>
  [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0')).join(':')

/** In-call strip above the chat (MASTER.md §6 "Call bar"). Audio is wired up in stage e. */
export function CallBar({
  peerName,
  startedAt,
  micLabel,
  muted,
  onToggleMute,
  onHangUp
}: {
  peerName: string
  startedAt: number
  micLabel: string
  muted: boolean
  onToggleMute: () => void
  onHangUp: () => void
}): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000))

  return (
    <div className="animate-rise px-4 pt-2.5">
      <div
        role="region"
        aria-label={`Call with ${peerName}`}
        className="cut panel panel-sm flex h-14 items-center gap-3.5 pr-3 pl-5 [--edge-c:color-mix(in_srgb,var(--online)_55%,transparent)] [--fill-c:var(--callbar)]"
      >
        <span className="label inline-flex items-center gap-2 text-online">
          <span aria-hidden="true" className="size-2 animate-pulse-soft bg-online shadow-[0_0_10px_var(--online)]" />
          Live
        </span>
        <span className="max-w-[40%] flex-none truncate font-semibold whitespace-nowrap">
          Call <span aria-hidden="true" className="text-text-muted">//</span> {peerName}
        </span>
        <span aria-hidden="true" className="flex h-5 flex-none items-center gap-[3px] max-[1000px]:hidden">
          {[0, 0.15, 0.3, 0.45, 0.6].map((delay) => (
            <span key={delay} className="h-full w-[3px] animate-wave bg-online" style={{ animationDelay: `${delay}s` }} />
          ))}
        </span>
        <span className="flex-none font-mono text-sm tracking-[0.06em] tabular-nums" aria-label="Call duration">
          {hms(elapsed)}
        </span>
        <div className="flex-1" />
        <Button variant="secondary" size="default" className="max-w-[200px] min-w-0 shrink normal-case tracking-[0.04em]" aria-haspopup="listbox" aria-label={`Microphone: ${micLabel}`}>
          <Mic />
          <span className="truncate text-xs">{micLabel}</span>
          <ChevronDown />
        </Button>
        <Button variant="icon" size="icon" aria-pressed={muted} aria-label={muted ? 'Unmute microphone' : 'Mute microphone'} onClick={onToggleMute}>
          {muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
        </Button>
        <Button variant="destructive" className="flex-none" onClick={onHangUp}>
          <PhoneOff />
          Hang up
        </Button>
      </div>
    </div>
  )
}
