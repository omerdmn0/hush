import { useEffect, useState, type ReactNode } from 'react'
import { LoaderCircle, Mic, MicOff, MonitorOff, MonitorUp, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { CallView } from '@/lib/call'
import { formatDuration } from '@/lib/callLogic'
import type { AudioDevice } from '@/lib/useAudioDevices'
import { cn } from '@/lib/utils'

const DEFAULT_MIC = 'default'

/** Call strip above the chat (MASTER.md §6 "Call bar"), for every call phase except incoming. */
export function CallBar({
  view,
  peerName,
  mics,
  micId,
  onMicChange,
  onToggleMute,
  onHangUp,
  onShare,
  onStopShare,
  shareNotice
}: {
  view: CallView
  peerName: string
  mics: AudioDevice[]
  micId: string
  onMicChange: (deviceId: string) => void
  onToggleMute: () => void
  onHangUp: () => void
  onShare: () => void
  onStopShare: () => void
  /** Why a share has no sound, or failed. */
  shareNotice: string | null
}): ReactNode {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (view.phase !== 'active') return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [view.phase])

  if (view.phase === 'idle' || view.phase === 'incoming') return null
  const ended = view.phase === 'ended'
  const live = view.phase === 'active'

  return (
    <div className="animate-rise px-4 pt-2.5">
      <div
        role="region"
        aria-label={`Call with ${peerName}`}
        className={cn(
          'cut panel panel-sm flex h-14 items-center gap-3.5 pr-3 pl-5',
          ended
            ? '[--edge-c:var(--border-strong)] [--fill-c:var(--surface)]'
            : '[--edge-c:color-mix(in_srgb,var(--online)_55%,transparent)] [--fill-c:var(--callbar)]'
        )}
      >
        {ended ? (
          <span role="status" className="label flex items-center gap-2 text-text">
            <PhoneOff aria-hidden="true" className="size-4 text-text-muted" />
            {view.endedText}
          </span>
        ) : live ? (
          <>
            <span className="label inline-flex flex-none items-center gap-2 text-online">
              <span aria-hidden="true" className="size-2 animate-pulse-soft bg-online shadow-[0_0_10px_var(--online)]" />
              Live
            </span>
            <span className="max-w-[40%] flex-none truncate font-semibold whitespace-nowrap">
              Call <span aria-hidden="true" className="text-text-muted">//</span> {peerName}
            </span>
            <span aria-hidden="true" className="flex h-5 flex-none items-center gap-[3px] max-[1000px]:hidden">
              {[0, 0.15, 0.3, 0.45, 0.6].map((delay) => (
                <span key={delay} className={cn('h-full w-[3px] bg-online', !view.muted && 'animate-wave')} style={{ animationDelay: `${delay}s` }} />
              ))}
            </span>
            <span className="flex-none font-mono text-sm tracking-[0.06em] tabular-nums" aria-label="Call duration">
              {formatDuration(now - (view.connectedAt ?? now))}
            </span>
          </>
        ) : (
          <span role="status" className="label flex min-w-0 items-center gap-2 text-online">
            <LoaderCircle aria-hidden="true" className="size-4 flex-none animate-spin" />
            <span className="truncate">
              {view.phase === 'connecting' ? 'Connecting audio…' : view.ringing ? `Ringing ${peerName}…` : `Calling ${peerName}…`}
            </span>
          </span>
        )}
        <div className="flex-1" />
        {live && (
          <>
            <Select value={micId || DEFAULT_MIC} onValueChange={(v) => onMicChange(v === DEFAULT_MIC ? '' : v)}>
              <SelectTrigger aria-label="Microphone" className="h-9 w-auto max-w-[200px] min-w-0 gap-1.5 bg-transparent font-mono text-xs tracking-[0.04em]">
                <Mic aria-hidden="true" className="size-4 flex-none" />
                <SelectValue />
              </SelectTrigger>
              <SelectContent position="popper" align="end">
                <SelectItem value={DEFAULT_MIC}>System default</SelectItem>
                {mics.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button variant="icon" size="icon" aria-pressed={view.muted} aria-label={view.muted ? 'Unmute microphone' : 'Mute microphone'} onClick={onToggleMute}>
              {view.muted ? <MicOff className="size-5" /> : <Mic className="size-5" />}
            </Button>
            {view.sharing ? (
              <Button variant="secondary" className="flex-none" onClick={onStopShare}>
                <MonitorOff />
                Stop sharing
              </Button>
            ) : (
              view.canShare && (
                <Button variant="icon" size="icon" aria-label="Share your screen" onClick={onShare}>
                  <MonitorUp className="size-5" />
                </Button>
              )
            )}
          </>
        )}
        {!ended && (
          <Button variant="destructive" className="flex-none" onClick={onHangUp}>
            <PhoneOff />
            {view.phase === 'outgoing' ? 'Cancel' : 'Hang up'}
          </Button>
        )}
      </div>
      {live && shareNotice && (
        <p role="status" className="m-0 mt-1 px-1 text-xs text-queued">
          {shareNotice}
        </p>
      )}
    </div>
  )
}
