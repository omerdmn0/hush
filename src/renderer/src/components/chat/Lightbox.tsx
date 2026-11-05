import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import type { ChatMessage } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { formatTime, fullDateTime } from '@/lib/format'

const mb = (bytes: number): string => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`)

/** Full-size image viewer. Radix traps focus, closes on Esc/backdrop and returns focus to the thumbnail. */
export function Lightbox({
  message,
  peerName,
  onClose,
  onClosed
}: {
  message: ChatMessage | null
  peerName: string
  onClose: () => void
  /** Puts focus back where it was (the dialog is opened by state, not by a Radix trigger). */
  onClosed: () => void
}): ReactNode {
  const image = message?.image
  return (
    <Dialog open={!!image} onOpenChange={(open) => !open && onClose()}>
      {message && image && (
        <DialogContent
          className="cut panel flex max-h-[94vh] max-w-[94vw] flex-col gap-3 p-4 [--edge-c:var(--cyan)] [--fill-c:var(--surface-elevated)]"
          onCloseAutoFocus={(e) => {
            e.preventDefault()
            onClosed()
          }}
        >
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <DialogTitle className="label m-0 truncate text-text">
                {message.from === 'me' ? 'You' : peerName} · <span title={fullDateTime(message.sentAt)}>{formatTime(message.sentAt)}</span>
              </DialogTitle>
              <DialogDescription className="data m-0 text-text-muted">
                {image.width}×{image.height} · {mb(image.size)}
                {!image.ready && ' · full image still arriving, showing preview'}
              </DialogDescription>
            </div>
            <DialogClose asChild>
              <Button variant="secondary" size="icon" aria-label="Close image (Esc)">
                <X className="size-5" />
              </Button>
            </DialogClose>
          </div>
          <div className="reticle grid min-h-0 place-items-center p-3">
            <img
              src={image.ready ? image.fullUrl : image.thumbUrl}
              alt={message.text || `Image from ${message.from === 'me' ? 'you' : peerName}`}
              className="block max-h-[74vh] max-w-[86vw] object-contain"
              draggable={false}
            />
          </div>
          {message.text && <p className="m-0 max-w-[70ch] self-center text-center text-base leading-6 whitespace-pre-wrap">{message.text}</p>}
        </DialogContent>
      )}
    </Dialog>
  )
}
