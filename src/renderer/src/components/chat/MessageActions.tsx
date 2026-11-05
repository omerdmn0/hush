import { useState, type ReactNode } from 'react'
import { Copy, Download, Ellipsis, Pencil, Reply, SmilePlus, Trash2 } from 'lucide-react'
import type { ChatMessage } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'
import { EmojiPanel } from './EmojiPanel'

export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥'] as const

export interface MessageActions {
  onReply: (m: ChatMessage) => void
  onEdit: (m: ChatMessage) => void
  onDelete: (m: ChatMessage) => void
  onReact: (m: ChatMessage, emoji: string, on: boolean) => void
  /** Save a copy of the image or file. */
  onSave: (m: ChatMessage) => void
  /** Scroll to a message (from a reply's quote). */
  onJump: (id: string) => void
  /** Briefly highlighted after a jump. */
  highlightId: string | null
  /** False while writing isn't possible (not paired, catching up after a restore). */
  canWrite: boolean
}

const hasMine = (m: ChatMessage, emoji: string): boolean => (m.reactions ?? []).some((r) => r.emoji === emoji && r.mine)

/** Hover / focus toolbar on a message. `menuOpen` is shared with the right-click menu. */
export function MessageToolbar({
  m,
  mine,
  actions,
  menuOpen,
  onMenuOpenChange
}: {
  m: ChatMessage
  mine: boolean
  actions: MessageActions
  menuOpen: boolean
  onMenuOpenChange: (open: boolean) => void
}): ReactNode {
  const [pickerOpen, setPickerOpen] = useState(false)
  const live = !m.deleted && !m.unsupported
  const write = actions.canWrite && live
  const item = 'flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover'
  return (
    <div
      className={cn(
        'cut panel panel-sm absolute -top-4 z-10 flex items-center gap-0.5 p-0.5 opacity-0 transition-opacity duration-150 [--fill-c:var(--surface-elevated)]',
        'pointer-events-none group-hover/msg:pointer-events-auto group-hover/msg:opacity-100 group-focus-within/msg:pointer-events-auto group-focus-within/msg:opacity-100',
        (menuOpen || pickerOpen) && 'pointer-events-auto opacity-100',
        // Docked at the far end of the message column, away from the avatar and name.
        mine ? 'left-0' : 'right-0'
      )}
    >
      {write &&
        QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            tabIndex={-1}
            aria-label={`React ${e}`}
            aria-pressed={hasMine(m, e)}
            onClick={() => actions.onReact(m, e, !hasMine(m, e))}
            className={cn('grid size-7 place-items-center rounded-sm text-base hover:bg-hover', hasMine(m, e) && 'bg-cyan-subtle')}
          >
            {e}
          </button>
        ))}
      {write && (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button variant="icon" size="icon" className="size-7" aria-label="Add reaction">
              <SmilePlus className="size-4" />
            </Button>
          </PopoverTrigger>
          <PopoverContent side="top" align="center" className="w-auto overflow-hidden p-0">
            <EmojiPanel
              onPick={(e) => {
                setPickerOpen(false)
                actions.onReact(m, e, !hasMine(m, e))
              }}
            />
          </PopoverContent>
        </Popover>
      )}
      {write && (
        <Button variant="icon" size="icon" className="size-7" aria-label="Reply" onClick={() => actions.onReply(m)}>
          <Reply className="size-4" />
        </Button>
      )}
      <Popover open={menuOpen} onOpenChange={onMenuOpenChange}>
        <PopoverTrigger asChild>
          <Button variant="icon" size="icon" className="size-7" aria-label="More actions">
            <Ellipsis className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align={mine ? 'end' : 'start'} className="flex w-48 flex-col p-1" aria-label="Message actions">
          {live && m.text && (
            <button
              type="button"
                className={item}
              onClick={() => {
                void navigator.clipboard.writeText(m.text)
                onMenuOpenChange(false)
              }}
            >
              <Copy aria-hidden="true" className="size-4 text-text-muted" />
              Copy text
            </button>
          )}
          {live && (m.image?.ready || m.file?.ready) && (
            <button type="button" className={item} onClick={() => (onMenuOpenChange(false), actions.onSave(m))}>
              <Download aria-hidden="true" className="size-4 text-text-muted" />
              {m.image ? 'Save image…' : 'Save as…'}
            </button>
          )}
          {write && (
            <button type="button" className={item} onClick={() => (onMenuOpenChange(false), actions.onReply(m))}>
              <Reply aria-hidden="true" className="size-4 text-text-muted" />
              Reply
            </button>
          )}
          {write && mine && (
            <button type="button" className={item} onClick={() => (onMenuOpenChange(false), actions.onEdit(m))}>
              <Pencil aria-hidden="true" className="size-4 text-text-muted" />
              Edit
            </button>
          )}
          <button
            type="button"
            className={cn(item, 'text-danger-text')}
            onClick={() => (onMenuOpenChange(false), actions.onDelete(m))}
          >
            <Trash2 aria-hidden="true" className="size-4" />
            Delete…
          </button>
        </PopoverContent>
      </Popover>
    </div>
  )
}

/** Emoji under a message. With two people, a count of 2 means both of you. */
export function ReactionChips({ m, mine, actions, peerName }: { m: ChatMessage; mine: boolean; actions: MessageActions; peerName: string }): ReactNode {
  if (!m.reactions?.length) return null
  return (
    <div className={cn('mt-1 flex flex-wrap gap-1', mine ? 'justify-end' : 'justify-start')}>
      {m.reactions.map((r) => {
        const who = r.mine && r.theirs ? `You and ${peerName}` : r.mine ? 'You' : peerName
        return (
          <button
            key={r.emoji}
            type="button"
            disabled={!actions.canWrite}
            aria-pressed={r.mine}
            aria-label={`${r.emoji} — ${who}. ${r.mine ? 'Remove yours' : 'Add yours'}`}
            title={who}
            onClick={() => actions.onReact(m, r.emoji, !r.mine)}
            className={cn(
              'flex h-6 items-center gap-1 rounded-sm border px-1.5 text-sm leading-none',
              r.mine ? 'border-cyan bg-cyan-subtle' : 'border-edge bg-surface hover:border-border-strong'
            )}
          >
            <span>{r.emoji}</span>
            {r.mine && r.theirs && <span className="data text-text">2</span>}
          </button>
        )
      })}
    </div>
  )
}

/** "Delete for everyone" (own messages) or "Delete for me" (any message, this computer only). */
export function DeleteDialog({ message, peerName, onClose }: { message: ChatMessage | null; peerName: string; onClose: () => void }): ReactNode {
  const [error, setError] = useState<string | null>(null)
  const mine = message?.from === 'me'
  const forEveryone = mine && !message?.deleted
  // Not sent yet: it can only be taken back for both of you.
  const forMe = !(mine && message?.status === 'queued')
  const run = async (mode: 'everyone' | 'me'): Promise<void> => {
    if (!message) return
    try {
      await window.hush.deleteMessage(message.id, mode)
      onClose()
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    }
  }
  return (
    <Dialog open={message !== null} onOpenChange={(open) => !open && (setError(null), onClose())}>
      {message && (
        <DialogContent className="cut panel flex w-[400px] flex-col gap-3 px-6 pt-6 pb-5 [--edge-c:var(--danger-text)] [--fill-c:var(--surface-elevated)]">
          <DialogTitle className="display m-0 flex items-center gap-2.5 text-base">
            <Trash2 aria-hidden="true" className="size-5 text-danger-text" />
            Delete message?
          </DialogTitle>
          <DialogDescription className="m-0 text-sm leading-5 text-text-muted">
            {forEveryone
              ? `“For everyone” erases it on both computers — ${peerName} sees “Message deleted”. ${message.status === 'queued' ? `It goes out the next time ${peerName} is online.` : ''}`
              : `This removes it from your computer only. ${peerName} still has it.`}
          </DialogDescription>
          {error && (
            <p role="alert" className="m-0 text-xs text-danger-text">
              {error}
            </p>
          )}
          <div className="mt-2 flex flex-wrap justify-end gap-2">
            <DialogClose asChild>
              <Button variant="secondary" autoFocus>
                Cancel
              </Button>
            </DialogClose>
            {forMe && (
              <Button variant={forEveryone ? 'secondary' : 'destructive'} onClick={() => void run('me')}>
                Delete for me
              </Button>
            )}
            {forEveryone && (
              <Button variant="destructive" onClick={() => void run('everyone')}>
                Delete for everyone
              </Button>
            )}
          </div>
        </DialogContent>
      )}
    </Dialog>
  )
}
