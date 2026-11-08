import { useState, type ReactNode } from 'react'
import { CircleAlert, Pencil, Trash2 } from 'lucide-react'
import { MAX_CHANNEL_NAME } from '../../../shared/protocol'
import type { ChannelInfo } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

const messageOf = (e: unknown): string => (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export function RenameChannelDialog({ channel, open, onOpenChange }: { channel: ChannelInfo; open: boolean; onOpenChange: (open: boolean) => void }): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <RenameForm channel={channel} onDone={() => onOpenChange(false)} />}
    </Dialog>
  )
}

function RenameForm({ channel, onDone }: { channel: ChannelInfo; onDone: () => void }): ReactNode {
  const [name, setName] = useState(channel.name)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const rename = async (): Promise<void> => {
    if (busy || !name.trim()) return
    setBusy(true)
    setError(null)
    try {
      await window.hush.renameChannel(channel.id, name)
      onDone()
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  return (
    <DialogContent className="cut panel flex w-[380px] flex-col gap-3 px-6 pt-6 pb-5 [--fill-c:var(--surface-elevated)]">
      <DialogTitle className="display m-0 flex items-center gap-2.5 text-base">
        <Pencil aria-hidden="true" className="size-5 text-cyan" />
        Rename channel
      </DialogTitle>
      <DialogDescription className="m-0 text-sm leading-5 text-text-muted">The new name appears on both computers.</DialogDescription>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void rename()
        }}
      >
        <Input
          aria-label="Channel name"
          aria-invalid={!!error}
          aria-describedby={error ? 'rename-channel-error' : undefined}
          autoFocus
          value={name}
          maxLength={MAX_CHANNEL_NAME}
          onChange={(e) => {
            setName(e.target.value)
            setError(null)
          }}
        />
        {error && (
          <div id="rename-channel-error" role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
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
            Rename
          </Button>
        </div>
      </form>
    </DialogContent>
  )
}

export function DeleteChannelDialog({ channel, open, onOpenChange }: { channel: ChannelInfo; open: boolean; onOpenChange: (open: boolean) => void }): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && <DeleteForm channel={channel} onDone={() => onOpenChange(false)} />}
    </Dialog>
  )
}

function DeleteForm({ channel, onDone }: { channel: ChannelInfo; onDone: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const erase = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await window.hush.deleteChannel(channel.id)
      onDone()
    } catch (e) {
      setError(messageOf(e))
      setBusy(false)
    }
  }

  return (
    <DialogContent className="cut panel flex w-[400px] flex-col gap-3 px-6 pt-6 pb-5 [--edge-c:var(--danger-text)] [--fill-c:var(--surface-elevated)]">
      <DialogTitle className="display m-0 flex items-center gap-2.5 text-base">
        <Trash2 aria-hidden="true" className="size-5 text-danger-text" />
        Delete channel?
      </DialogTitle>
      <DialogDescription className="m-0 text-sm leading-5 text-text-muted">
        Every message, picture and file in <strong className="font-semibold text-text">#{channel.name}</strong> is permanently erased on both computers. This
        can&apos;t be undone. Backup files you&apos;ve already made still contain it.
      </DialogDescription>
      {error && (
        <p role="alert" className="m-0 text-xs text-danger-text">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <DialogClose asChild>
          <Button variant="secondary" autoFocus>
            Cancel
          </Button>
        </DialogClose>
        <Button variant="destructive" disabled={busy} onClick={() => void erase()}>
          <Trash2 />
          Delete channel
        </Button>
      </div>
    </DialogContent>
  )
}
