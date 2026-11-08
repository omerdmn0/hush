import { useState, type ReactNode } from 'react'
import { CircleAlert, Hash } from 'lucide-react'
import { MAX_CHANNEL_NAME } from '../../../shared/protocol'
import type { ChannelInfo } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

export function NewChannelDialog({
  open,
  onOpenChange,
  onCreated
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (channel: ChannelInfo) => void
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <NewChannelForm onCreated={onCreated} />}
    </Dialog>
  )
}

function NewChannelForm({ onCreated }: { onCreated: (channel: ChannelInfo) => void }): ReactNode {
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const create = async (): Promise<void> => {
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      onCreated(await window.hush.createChannel(name))
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
      setBusy(false)
    }
  }

  return (
    <DialogContent className="cut panel flex w-[380px] flex-col gap-3 px-6 pt-6 pb-5 [--fill-c:var(--surface-elevated)]">
      <DialogTitle className="display m-0 flex items-center gap-2.5 text-base">
        <Hash aria-hidden="true" className="size-5 text-cyan" />
        New channel
      </DialogTitle>
      <DialogDescription className="m-0 text-sm leading-5 text-text-muted">It appears on both computers. Its name is encrypted on disk.</DialogDescription>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void create()
        }}
      >
        <Input
          aria-label="Channel name"
          aria-invalid={!!error}
          aria-describedby={error ? 'new-channel-error' : undefined}
          autoFocus
          value={name}
          maxLength={MAX_CHANNEL_NAME}
          placeholder="Channel name"
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
        />
        {error && (
          <div id="new-channel-error" role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
            {error}
          </div>
        )}
        <div className="mt-1 flex justify-end gap-2">
          <DialogClose asChild>
            <Button variant="secondary" type="button">
              Cancel
            </Button>
          </DialogClose>
          <Button type="submit" disabled={busy || !name.trim()}>
            Create
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}
