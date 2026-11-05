import type { ReactNode } from 'react'
import { Phone, PhoneOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Avatar } from '@/components/common'

/** Incoming call (MASTER.md §6): Esc declines; clicking outside does nothing (no accidental decline). */
export function IncomingCall({
  open,
  peerName,
  onAccept,
  onDecline
}: {
  open: boolean
  peerName: string
  onAccept: () => void
  onDecline: () => void
}): ReactNode {
  return (
    <Dialog open={open}>
      {open && (
        <DialogContent
          className="cut panel flex w-[360px] flex-col items-center gap-1.5 px-6 pt-7 pb-6 text-center [--edge-c:var(--magenta)] [--fill-c:var(--surface-elevated)]"
          onEscapeKeyDown={onDecline}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div aria-hidden="true" className="relative p-2.5 before:absolute before:inset-0 before:animate-[spin_6s_linear_infinite] before:rounded-full before:border-2 before:border-dashed before:border-magenta">
            <Avatar name={peerName} who="peer" size={72} />
          </div>
          <DialogTitle className="display glitch m-0 mt-2.5 text-lg leading-[26px]">Incoming call</DialogTitle>
          <DialogDescription className="m-0">{peerName} is calling</DialogDescription>
          <div className="data text-text-muted">ESC TO DECLINE</div>
          <div className="mt-5 flex w-full gap-3">
            <Button variant="destructive" size="lg" className="flex-1" onClick={onDecline}>
              <PhoneOff />
              Decline
            </Button>
            <Button variant="accept" size="lg" className="flex-1" onClick={onAccept} autoFocus>
              <Phone />
              Accept
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
