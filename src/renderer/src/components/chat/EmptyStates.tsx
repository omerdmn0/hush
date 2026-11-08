import type { ReactNode } from 'react'
import { MessageCircle, Network } from 'lucide-react'
import { Button } from '@/components/ui/button'

function Empty({ icon, title, children, action }: { icon: ReactNode; title: string; children: ReactNode; action: ReactNode }): ReactNode {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="cut panel flex max-w-sm flex-col items-center gap-2 px-8 py-7 text-center">
        <div className="reticle mb-1 p-2.5 text-cyan" aria-hidden="true">
          {icon}
        </div>
        <h2 className="m-0 text-base font-semibold">{title}</h2>
        <p className="m-0 mb-2 text-text-muted">{children}</p>
        {action}
      </div>
    </div>
  )
}

/** Peer configured, no messages yet. */
export function EmptyChat({ peerName, onSayHi }: { peerName: string; onSayHi: () => void }): ReactNode {
  return (
    <Empty
      icon={<MessageCircle className="size-[30px]" />}
      title="No messages yet"
      action={<Button onClick={onSayHi}>Say hi to {peerName}</Button>}
    >
      Your conversation with {peerName} lives only on your two computers.
    </Empty>
  )
}

/** No peer IP configured yet. `ownIp` undefined = still checking. */
export function FirstRun({ ownIp, onOpenSettings }: { ownIp: string | null | undefined; onOpenSettings: () => void }): ReactNode {
  return (
    <Empty
      icon={<Network className="size-[30px]" />}
      title="Connect to your person"
      action={<Button onClick={onOpenSettings}>Open connection settings</Button>}
    >
      {ownIp === null ? (
        <>Tailscale doesn't seem to be running on this computer. Start it, then add the other person's Tailscale IP.</>
      ) : (
        <>
          Add their Tailscale IP to connect.
          {ownIp && (
            <>
              {' '}
              Yours is <span className="data text-text">{ownIp}</span>.
            </>
          )}
        </>
      )}
    </Empty>
  )
}
