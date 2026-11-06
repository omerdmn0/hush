import { useEffect, useState, type ReactNode } from 'react'
import { Construction, LoaderCircle, MonitorUp } from 'lucide-react'
import type { ShareOptions } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import type { ShareChoice } from '@/lib/screenShare'
import { cn } from '@/lib/utils'

const OFF = 'off'
const ALL = 'all'
const APP = 'app:'

/** Screen audio isn't finished: this says so wherever it can be turned on. */
function WorkInProgress({ untested }: { untested: boolean }): ReactNode {
  return (
    <span className="label inline-flex items-center gap-1.5 border border-queued px-1.5 py-0.5 text-queued">
      <Construction aria-hidden="true" className="size-3.5" />
      Work in progress{untested && ' · Untested'}
    </span>
  )
}

/** Choose what to share. On Wayland the system asks for the screen itself after this. */
export function ShareDialog({
  open,
  peerName,
  onClose,
  onStart
}: {
  open: boolean
  peerName: string
  onClose: () => void
  onStart: (choice: ShareChoice) => void
}): ReactNode {
  const [options, setOptions] = useState<ShareOptions | null>(null)
  const [sourceId, setSourceId] = useState<string | null>(null)
  const [audio, setAudio] = useState(OFF)

  useEffect(() => {
    if (!open) return
    setOptions(null)
    setAudio(OFF)
    void window.hush.shareOptions().then((o) => {
      setOptions(o)
      setSourceId(o.sources?.[0]?.id ?? null)
    })
  }, [open])

  const support = options?.audio
  const start = (): void => onStart({ sourceId, audioTarget: audio === OFF ? null : audio === ALL ? ALL : audio.slice(APP.length) })

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      {open && (
        <DialogContent className="cut panel flex max-h-[88vh] w-[560px] max-w-[92vw] flex-col gap-3.5 px-6 pt-6 pb-5 [--edge-c:var(--cyan)] [--fill-c:var(--surface-elevated)]">
          <DialogTitle className="display m-0 flex items-center gap-2.5 text-base">
            <MonitorUp aria-hidden="true" className="size-5 text-cyan" />
            Share your screen
          </DialogTitle>
          <DialogDescription className="m-0 text-sm leading-5 text-text-muted">
            {options?.sources === null
              ? `${peerName} will see what you pick. Your system asks which screen or window next.`
              : `${peerName} will see what you pick. It goes straight to their computer, through this call.`}
          </DialogDescription>

          {!options ? (
            <LoaderCircle role="img" aria-label="Loading" className="mx-auto my-6 size-6 animate-spin text-text-muted" />
          ) : (
            <>
              {options.sources && (
                <div role="radiogroup" aria-label="What to share" className="grid min-h-0 grid-cols-2 gap-2 overflow-y-auto p-0.5 sm:grid-cols-3">
                  {options.sources.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      role="radio"
                      aria-checked={sourceId === s.id}
                      onClick={() => setSourceId(s.id)}
                      className={cn('flex min-w-0 flex-col gap-1 border p-1.5 text-left', sourceId === s.id ? 'border-cyan bg-cyan-subtle' : 'border-edge hover:bg-hover')}
                    >
                      <img src={s.thumb} alt="" className="aspect-video w-full bg-pressed object-contain" />
                      <span className="truncate text-xs">{s.name}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="flex flex-col gap-1.5 border-t border-edge pt-3">
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="share-audio">Screen audio</Label>
                  <WorkInProgress untested={support?.kind === 'windows'} />
                </div>
                {support?.kind === 'none' ? (
                  <p className="m-0 text-xs text-text-muted">{support.reason} Your screen can still be shared, without sound.</p>
                ) : (
                  <>
                    <Select value={audio} onValueChange={setAudio}>
                      <SelectTrigger id="share-audio" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        <SelectItem value={OFF}>No sound</SelectItem>
                        <SelectItem value={ALL}>Everything except Hush</SelectItem>
                        {support?.kind === 'linux' &&
                          support.apps.map((a) => (
                            <SelectItem key={a.key} value={APP + a.key}>
                              Only {a.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    <p className="m-0 text-xs text-text-muted">
                      {support?.kind === 'windows'
                        ? 'This has not been tested on a real Windows PC yet, and may not work. If it fails, your screen is still shared, without sound.'
                        : 'This feature is still being finished. If it fails, your screen is still shared, without sound.'}{' '}
                      The call itself is left out, so {peerName} won't hear an echo of their voice.
                    </p>
                  </>
                )}
              </div>
            </>
          )}

          <div className="mt-1 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary">Cancel</Button>
            </DialogClose>
            <Button disabled={!options || (options.sources !== null && sourceId === null)} onClick={start}>
              <MonitorUp />
              Share
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
