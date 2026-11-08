import type { ReactNode, Ref } from 'react'
import { Phone, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, HudLabel, StatusTag } from '@/components/common'
import type { CallAction, PeerView } from '@/lib/view'

export function ChatHeader({
  peer,
  channelName,
  call,
  onSearch,
  searchOpen,
  searchButtonRef
}: {
  peer: PeerView | null
  /** The channel on screen; absent until paired. */
  channelName?: string
  call: CallAction
  /** Opens message search (absent when there's nothing to search). */
  onSearch?: () => void
  searchOpen?: boolean
  searchButtonRef?: Ref<HTMLButtonElement>
}): ReactNode {
  const online = peer?.presence === 'online'
  return (
    <header className="relative flex h-16 flex-none items-center gap-3 bg-app pr-4 pl-6 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,var(--cyan),var(--edge)_45%,var(--edge))] after:opacity-80">
      {peer && <Avatar name={peer.name} who="peer" size={32} />}
      <div className="flex min-w-0 flex-col gap-0.5">
        {channelName ? (
          <div className="truncate text-xs leading-4 font-semibold text-cyan">
            <span aria-hidden="true"># </span>
            {channelName}
          </div>
        ) : (
          <HudLabel>Link</HudLabel>
        )}
        <h1 className="m-0 truncate text-lg leading-6 font-semibold">{peer?.name ?? 'Not linked'}</h1>
      </div>
      {peer && <StatusTag online={online} className="ml-2" />}
      <div className="flex-1" />
      {onSearch && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button ref={searchButtonRef} variant="icon" size="icon" aria-label="Search messages" aria-expanded={searchOpen} onClick={onSearch}>
              <Search className="size-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Search messages (Ctrl+F)</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="icon"
            size="icon"
            aria-label={call.enabled ? call.hint : `Voice call (${call.hint})`}
            aria-disabled={!call.enabled}
            onClick={() => call.enabled && call.onCall()}
          >
            <Phone className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{call.hint}</TooltipContent>
      </Tooltip>
    </header>
  )
}
