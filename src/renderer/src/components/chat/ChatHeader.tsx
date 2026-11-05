import type { ReactNode } from 'react'
import { Phone } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, HudLabel, StatusTag } from '@/components/common'
import type { PeerView } from '@/lib/view'

export function ChatHeader({ peer }: { peer: PeerView | null }): ReactNode {
  const online = peer?.presence === 'online'
  // Voice calls arrive in stage e.
  const hint = !peer ? 'No one linked yet' : !online ? `${peer.name} is offline` : "Voice calls aren't available yet"
  return (
    <header className="relative flex h-16 flex-none items-center gap-3 bg-app pr-4 pl-6 after:absolute after:inset-x-0 after:bottom-0 after:h-px after:bg-[linear-gradient(90deg,var(--cyan),var(--edge)_45%,var(--edge))] after:opacity-80">
      {peer && <Avatar name={peer.name} who="peer" size={32} />}
      <div className="flex min-w-0 flex-col gap-0.5">
        <HudLabel>Channel</HudLabel>
        <h1 className="m-0 truncate text-lg leading-6 font-semibold">{peer?.name ?? 'Not linked'}</h1>
      </div>
      {peer && <StatusTag online={online} className="ml-2" />}
      <div className="flex-1" />
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="icon" size="icon" aria-label={`Voice call (${hint})`} aria-disabled>
            <Phone className="size-5" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{hint}</TooltipContent>
      </Tooltip>
    </header>
  )
}
