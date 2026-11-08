import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { AvatarUrls } from '../../../shared/types'
import { initial } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Logo({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 512 512" aria-hidden="true" className={className}>
      <defs>
        <linearGradient id="logo-corona" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#FF2E88" />
          <stop offset=".5" stopColor="#9B3DFF" />
          <stop offset="1" stopColor="#00E5FF" />
        </linearGradient>
      </defs>
      <path fill="#0D0B14" d="M0 0H400L512 112V512H112L0 400Z" />
      <path
        fill="#08070D"
        stroke="url(#logo-corona)"
        strokeWidth="42"
        d="M190.2 374.8L72 464L126.1 315.0A150 150 0 1 1 190.2 374.8Z"
      />
      <path fill="url(#logo-corona)" d="M82.0 239.2A174 174 0 1 1 256.8 414.0A134 134 0 1 0 82.0 239.2Z" />
      <path fill="#FFFFFF" d="M364 14L388 108L482 132L388 156L364 250L340 156L246 132L340 108Z" />
    </svg>
  )
}

/** Current profile pictures; Avatar falls back to initials when there is none. */
export const AvatarContext = createContext<AvatarUrls>({ self: null, peer: null })

/** Chamfered-square avatar: profile picture, or the person's initial (MASTER.md §4). */
export function Avatar({
  name,
  who,
  size = 36,
  className
}: {
  name: string
  who: 'me' | 'peer'
  size?: number
  className?: string
}): ReactNode {
  const style = {
    '--s': `${size}px`,
    width: size,
    height: size,
    fontSize: Math.round(size * 0.42),
    background: who === 'me' ? 'var(--avatar-me)' : 'var(--avatar-peer)'
  } as CSSProperties
  const urls = useContext(AvatarContext)
  const src = who === 'me' ? urls.self : urls.peer
  return (
    <div aria-hidden="true" style={style} className={cn('chamfer-avatar grid flex-none place-items-center overflow-hidden font-bold text-text', className)}>
      {src ? <img src={src} alt="" draggable={false} className="h-full w-full object-cover" /> : initial(name)}
    </div>
  )
}

/** Square status mark + label; never colour-only (MASTER.md §2 rules). */
export function StatusTag({ online, className }: { online: boolean; className?: string }): ReactNode {
  return (
    <span className={cn('label inline-flex items-center gap-1.5', online ? 'text-online' : 'text-text-muted', className)}>
      <span
        aria-hidden="true"
        className={cn('size-2 flex-none', online ? 'bg-online shadow-[0_0_8px_var(--online)]' : 'border-2 border-offline')}
      />
      {online ? 'Online' : 'Offline'}
    </span>
  )
}

/** "// LABEL" section header; the slashes are decoration and hidden from screen readers. */
export function HudLabel({ children, className }: { children: ReactNode; className?: string }): ReactNode {
  return (
    <div className={cn('label', className)}>
      <span aria-hidden="true">// </span>
      {children}
    </div>
  )
}
