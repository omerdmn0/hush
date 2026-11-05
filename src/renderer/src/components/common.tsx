import { createContext, useContext, type CSSProperties, type ReactNode } from 'react'
import type { AvatarUrls } from '../../../shared/types'
import { initial } from '@/lib/format'
import { cn } from '@/lib/utils'

export function Logo({ className }: { className?: string }): ReactNode {
  return (
    <svg viewBox="0 0 64 64" aria-hidden="true" className={className}>
      <path fill="#0D0B14" d="M0 0H50L64 14V64H14L0 50Z" />
      <path fill="#00E5FF" d="M9 14H43L51 22V38L45 44H25L15 53V44H9Z" />
      <path fill="#FF2E88" d="M12 14H46L54 22V38L48 44H28L18 53V44H12Z" />
      <path fill="#0D0B14" d="M35 21.7a9.5 9.5 0 1 0 4.3 15.9 8 8 0 0 1-4.3-15.9z" />
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
