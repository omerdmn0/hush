import type { ReactNode } from 'react'
import { Power } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'

/** Confirms a real quit — closing the window only hides Hush to the tray. */
export function QuitDialog({
  open,
  inCall,
  peerName,
  onOpenChange
}: {
  open: boolean
  inCall: boolean
  peerName: string
  onOpenChange: (open: boolean) => void
}): ReactNode {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open && (
        <DialogContent className="cut panel flex w-[380px] flex-col gap-3 px-6 pt-6 pb-5 [--edge-c:var(--danger-text)] [--fill-c:var(--surface-elevated)]">
          <DialogTitle className="display m-0 flex items-center gap-2.5 text-base">
            <Power aria-hidden="true" className="size-5 text-danger-text" />
            Quit Hush?
          </DialogTitle>
          <DialogDescription className="m-0 text-sm leading-5 text-text-muted">
            {inCall ? `This ends your call with ${peerName}. ` : ''}
            You won&apos;t receive messages or calls until you open Hush again. Messages sent to you meanwhile arrive when you&apos;re both
            online.
          </DialogDescription>
          <div className="mt-2 flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="destructive" onClick={() => window.hush.quit()}>
              <Power />
              Quit
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
