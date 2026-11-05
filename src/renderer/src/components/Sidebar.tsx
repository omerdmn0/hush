import type { ReactNode, Ref } from 'react'
import { Phone, Settings, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, HudLabel, Logo, StatusTag } from '@/components/common'
import type { CallAction, PeerView } from '@/lib/view'

export function Sidebar({
  peer,
  myName,
  call,
  onOpenSettings,
  onLinkPeer,
  settingsButtonRef
}: {
  peer: PeerView | null
  myName: string
  call: CallAction
  onOpenSettings: () => void
  onLinkPeer: () => void
  settingsButtonRef: Ref<HTMLButtonElement>
}): ReactNode {
  return (
    <aside aria-label="Contact" className="flex w-60 flex-none flex-col border-r border-edge bg-sidebar">
      <div className="flex items-center gap-2.5 px-4 pt-4 pb-3">
        <Logo className="size-[30px] flex-none" />
        <div>
          <div className="glitch-hover cursor-default font-display text-lg leading-6 font-extrabold tracking-[0.24em] uppercase [text-shadow:var(--chroma)]">
            Hush
          </div>
          <div className="data tracking-[0.06em] text-magenta">P2P // PRIVATE</div>
        </div>
      </div>

      <HudLabel className="px-4 pt-2 pb-1.5">Link</HudLabel>
      {peer ? <PeerCard peer={peer} call={call} /> : <NoPeerCard onOpenSettings={onLinkPeer} />}

      <div className="flex-1" />
      <div className="data mx-4 mb-3 flex items-start gap-2 text-text-muted">
        <ShieldCheck aria-hidden="true" className="mt-px size-4 flex-none text-online" />
        <span>Direct via Tailscale · no servers</span>
      </div>
      <div className="flex items-center gap-2.5 border-t border-edge p-3">
        <Avatar name={myName || 'You'} who="me" size={32} />
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{myName || 'Set your name'}</div>
          <div className="label text-magenta">You</div>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button ref={settingsButtonRef} variant="icon" size="icon" aria-label="Settings" onClick={onOpenSettings}>
              <Settings className="size-5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Settings</TooltipContent>
        </Tooltip>
      </div>
    </aside>
  )
}

function PeerCard({ peer, call }: { peer: PeerView; call: CallAction }): ReactNode {
  const online = peer.presence === 'online'
  return (
    <div className="cut panel mx-3 flex flex-col items-center gap-1.5 px-4 pt-[18px] pb-4 text-center">
      <div className="reticle">
        <Avatar name={peer.name} who="peer" size={72} />
      </div>
      <div className="mt-1 max-w-full truncate text-lg leading-[26px] font-semibold">{peer.name}</div>
      <StatusTag online={online} />
      <div className="data text-text-muted">{online ? 'LINK DIRECT · P2P' : peer.lastSeen ? `LAST SEEN ${peer.lastSeen}` : 'NOT CONNECTED YET'}</div>
      <div className="data text-text-muted">NODE {peer.ip}</div>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            className="mt-2.5 w-full"
            aria-disabled={!call.enabled}
            aria-label={call.enabled ? call.hint : `Call ${peer.name} (${call.hint})`}
            onClick={() => call.enabled && call.onCall()}
          >
            <Phone />
            Call
          </Button>
        </TooltipTrigger>
        <TooltipContent>{call.hint}</TooltipContent>
      </Tooltip>
    </div>
  )
}

function NoPeerCard({ onOpenSettings }: { onOpenSettings: () => void }): ReactNode {
  return (
    <div className="cut panel mx-3 flex flex-col items-center gap-2 px-4 py-5 text-center">
      <div className="font-semibold">No one linked yet</div>
      <p className="m-0 text-xs leading-4 text-text-muted">Add the other person's Tailscale IP to open your private channel.</p>
      <Button variant="secondary" size="sm" className="mt-1" onClick={onOpenSettings}>
        Open settings
      </Button>
    </div>
  )
}
