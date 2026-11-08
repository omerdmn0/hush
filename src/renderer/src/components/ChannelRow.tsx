import { useState, type ReactNode } from 'react'
import { Bell, BellOff, Ellipsis, Hash, Pencil, Trash2 } from 'lucide-react'
import { GENERAL_CHANNEL } from '../../../shared/protocol'
import type { ChannelInfo } from '../../../shared/types'
import { DeleteChannelDialog, RenameChannelDialog } from '@/components/ChannelDialogs'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cn } from '@/lib/utils'

const ITEM = 'flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-left text-sm hover:bg-hover focus-visible:bg-hover'

/** One channel in the sidebar: opens it, shows what's unread, and holds its menu. */
export function ChannelRow({
  channel,
  active,
  unread,
  canManage,
  onSelect
}: {
  channel: ChannelInfo
  active: boolean
  unread: number
  /** Renaming and deleting need both computers ready; muting is only ever local. */
  canManage: boolean
  onSelect: () => void
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<'rename' | 'delete' | null>(null)
  const manageable = canManage && channel.id !== GENERAL_CHANNEL
  const label = `${channel.name}${unread > 0 ? `, ${unread} unread` : ''}${channel.muted ? ', muted' : ''}`

  return (
    <div
      className="group/row relative flex-none"
      onContextMenu={(e) => {
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <button
        type="button"
        aria-label={label}
        aria-current={active ? 'true' : undefined}
        onClick={onSelect}
        className="flex h-[34px] w-full items-center gap-2 rounded-sm border-l-2 border-transparent pr-9 pl-3 text-left text-sm font-medium text-text-muted hover:bg-hover hover:text-text aria-[current=true]:border-cyan aria-[current=true]:bg-cyan-subtle aria-[current=true]:text-text"
      >
        <Hash aria-hidden="true" className="size-3.5 flex-none opacity-60" />
        <span className="truncate">{channel.name}</span>
      </button>

      <div
        className={cn(
          'pointer-events-none absolute top-1/2 right-2 flex -translate-y-1/2 items-center gap-1.5 group-hover/row:opacity-0 group-has-[:focus-visible]/row:opacity-0',
          menuOpen && 'opacity-0'
        )}
      >
        {channel.muted && <BellOff aria-hidden="true" className="size-3.5 text-text-muted" />}
        {unread > 0 && (
          <span aria-hidden="true" className={cn('data rounded-sm px-1.5 leading-[18px]', channel.muted ? 'bg-pressed text-text-muted' : 'bg-cyan text-on-cyan')}>
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </div>

      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="icon"
            size="icon"
            aria-label={`Actions for ${channel.name}`}
            className={cn(
              'absolute top-1/2 right-0.5 size-7 -translate-y-1/2 opacity-0 group-hover/row:opacity-100 group-has-[:focus-visible]/row:opacity-100',
              menuOpen && 'opacity-100'
            )}
          >
            <Ellipsis className="size-4" />
          </Button>
        </PopoverTrigger>
        <PopoverContent side="right" align="start" className="flex w-48 flex-col p-1" aria-label={`Actions for ${channel.name}`}>
          <button
            type="button"
            className={ITEM}
            onClick={() => {
              setMenuOpen(false)
              window.hush.setChannelMuted(channel.id, !channel.muted)
            }}
          >
            {channel.muted ? <Bell aria-hidden="true" className="size-4 text-text-muted" /> : <BellOff aria-hidden="true" className="size-4 text-text-muted" />}
            {channel.muted ? 'Unmute' : 'Mute notifications'}
          </button>
          {manageable && (
            <button type="button" className={ITEM} onClick={() => (setMenuOpen(false), setDialog('rename'))}>
              <Pencil aria-hidden="true" className="size-4 text-text-muted" />
              Rename…
            </button>
          )}
          {manageable && (
            <button type="button" className={cn(ITEM, 'text-danger-text')} onClick={() => (setMenuOpen(false), setDialog('delete'))}>
              <Trash2 aria-hidden="true" className="size-4" />
              Delete…
            </button>
          )}
        </PopoverContent>
      </Popover>

      <RenameChannelDialog channel={channel} open={dialog === 'rename'} onOpenChange={(open) => setDialog(open ? 'rename' : null)} />
      <DeleteChannelDialog channel={channel} open={dialog === 'delete'} onOpenChange={(open) => setDialog(open ? 'delete' : null)} />
    </div>
  )
}
