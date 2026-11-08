import type { ReactNode, Ref } from 'react'
import { Hash, Phone, Plus, Power, Settings, ShieldCheck } from 'lucide-react'
import type { ChannelInfo } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Avatar, HudLabel, Logo, StatusTag } from '@/components/common'
import type { CallAction, PeerView } from '@/lib/view'
import { cn } from '@/lib/utils'

/** At short window heights the peer card gives up its avatar and details so channels have room. */
const HIDE_WHEN_SHORT = '[@media(max-height:719px)]:hidden'

export function Sidebar({
  peer,
  channels,
  activeChannel,
  onSelectChannel,
  onNewChannel,
  newChannelBlocked,
  myName,
  call,
  onOpenSettings,
  onLinkPeer,
  onQuit,
  paired,
  updateHint,
  settingsButtonRef
}: {
  peer: PeerView | null
  /** Null until paired: there's nothing to organise before then. */
  channels: ChannelInfo[] | null
  activeChannel: string
  onSelectChannel: (id: string) => void
  onNewChannel: () => void
  /** Why a channel can't be created right now; null if it can. */
  newChannelBlocked: string | null
  myName: string
  call: CallAction
  onOpenSettings: () => void
  onLinkPeer: () => void
  onQuit: () => void
  paired: boolean
  updateHint: string | null
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
      {peer ? <PeerCard peer={peer} call={call} paired={paired} /> : <NoPeerCard onOpenSettings={onLinkPeer} />}

      {channels ? (
        <>
          <div className="flex flex-none items-center justify-between pt-3 pr-3 pb-1 pl-4">
            <HudLabel>Channels</HudLabel>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="icon"
                  size="icon"
                  className="size-7"
                  aria-label={newChannelBlocked ? `New channel (${newChannelBlocked})` : 'New channel'}
                  aria-disabled={!!newChannelBlocked}
                  onClick={() => !newChannelBlocked && onNewChannel()}
                >
                  <Plus className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{newChannelBlocked ?? 'New channel'}</TooltipContent>
            </Tooltip>
          </div>
          <nav aria-label="Channels" className="mb-3 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-3">
            {channels.map((c) => (
              <button
                key={c.id}
                aria-current={c.id === activeChannel ? 'true' : undefined}
                onClick={() => onSelectChannel(c.id)}
                className="flex h-[34px] flex-none items-center gap-2 rounded-sm border-l-2 border-transparent px-3 text-left text-sm font-medium text-text-muted hover:bg-hover hover:text-text aria-[current=true]:border-cyan aria-[current=true]:bg-cyan-subtle aria-[current=true]:text-text"
              >
                <Hash aria-hidden="true" className="size-3.5 flex-none opacity-60" />
                <span className="truncate">{c.name}</span>
              </button>
            ))}
          </nav>
        </>
      ) : (
        <div className="flex-1" />
      )}
      {updateHint && (
        <div role="status" className="data mx-4 mb-3 border-l-2 border-queued pl-2 text-queued">
          {updateHint}
        </div>
      )}
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
            <Button variant="icon" size="icon" aria-label="Quit Hush" aria-keyshortcuts="Control+Q" onClick={onQuit} className="hover:not-disabled:text-danger-text">
              <Power className="size-[18px]" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Quit Hush (Ctrl+Q)</TooltipContent>
        </Tooltip>
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

function PeerCard({ peer, call, paired }: { peer: PeerView; call: CallAction; paired: boolean }): ReactNode {
  const online = peer.presence === 'online'
  return (
    <div className="cut panel mx-3 flex flex-col items-center gap-1.5 px-4 pt-[18px] pb-4 text-center">
      <div className={cn('reticle', HIDE_WHEN_SHORT)}>
        <Avatar name={peer.name} who="peer" size={72} />
      </div>
      <div className="mt-1 max-w-full truncate text-lg leading-[26px] font-semibold">{peer.name}</div>
      <StatusTag online={online} />
      <div className={cn('data', paired ? cn('text-text-muted', HIDE_WHEN_SHORT) : 'text-queued')}>
        {!paired ? 'PAIRING NEEDED' : online ? 'LINK VERIFIED · P2P' : peer.lastSeen ? `LAST SEEN ${peer.lastSeen}` : 'NOT CONNECTED YET'}
      </div>
      <div className={cn('data text-text-muted', HIDE_WHEN_SHORT)}>NODE {peer.ip}</div>
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
      <p className="m-0 text-xs leading-4 text-text-muted">Add the other person's Tailscale IP to open your private link.</p>
      <Button variant="secondary" size="sm" className="mt-1" onClick={onOpenSettings}>
        Open settings
      </Button>
    </div>
  )
}
