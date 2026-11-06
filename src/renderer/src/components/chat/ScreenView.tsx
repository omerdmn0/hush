import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Maximize, Volume2 } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** The other person's shared screen, above the chat. Its sound has its own volume, apart from their voice. */
export function ScreenView({ stream, peerName, audio, speakerId }: { stream: MediaStream; peerName: string; audio: boolean; speakerId: string }): ReactNode {
  const video = useRef<HTMLVideoElement>(null)
  const [volume, setVolume] = useState(1)

  useEffect(() => {
    const el = video.current
    if (!el) return
    el.srcObject = stream
    void el.play().catch(() => {})
    return () => {
      el.srcObject = null
    }
  }, [stream])
  useEffect(() => {
    void (video.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null)?.setSinkId?.(speakerId).catch(() => {})
  }, [speakerId])
  useEffect(() => {
    if (video.current) video.current.volume = volume
  }, [volume])

  return (
    <section aria-label={`${peerName}'s screen`} className="animate-rise flex h-[46%] min-h-[220px] flex-none flex-col gap-1.5 px-4 pt-2.5">
      <div className="flex flex-none items-center gap-3">
        <span className="label text-online">{peerName}'s screen</span>
        <div className="flex-1" />
        {audio && (
          <label className="flex items-center gap-2 text-text-muted">
            <Volume2 aria-hidden="true" className="size-4" />
            <span className="sr-only">Screen audio volume</span>
            <input type="range" min={0} max={1} step={0.05} value={volume} onChange={(e) => setVolume(Number(e.target.value))} className="w-28 accent-cyan" />
          </label>
        )}
        <Button variant="icon" size="icon" className="size-8" aria-label="Full screen" onClick={() => void video.current?.requestFullscreen()}>
          <Maximize className="size-4" />
        </Button>
      </div>
      <video ref={video} autoPlay playsInline className="min-h-0 w-full flex-1 bg-black object-contain" />
    </section>
  )
}
