import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage } from '../../shared/types'
import { Sidebar } from '@/components/Sidebar'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { CircleCheck } from 'lucide-react'
import { deliveredText, MessageList } from '@/components/chat/MessageList'
import { Composer } from '@/components/chat/Composer'
import { EmptyChat, FirstRun } from '@/components/chat/EmptyStates'
import { SettingsScreen, type SectionId } from '@/components/settings/SettingsScreen'
import { formatLastSeen } from '@/lib/format'
import { useHush } from '@/lib/useHush'
import type { PeerView } from '@/lib/view'

/** True while the user can actually see the chat (window focused and visible). */
function useWindowActive(): boolean {
  const [active, setActive] = useState(() => document.hasFocus() && document.visibilityState === 'visible')
  useEffect(() => {
    const update = (): void => setActive(document.hasFocus() && document.visibilityState === 'visible')
    window.addEventListener('focus', update)
    window.addEventListener('blur', update)
    document.addEventListener('visibilitychange', update)
    return () => {
      window.removeEventListener('focus', update)
      window.removeEventListener('blur', update)
      document.removeEventListener('visibilitychange', update)
    }
  }, [])
  return active
}

export default function App(): ReactNode {
  const hush = useHush()
  const { snapshot, messages, markRead } = hush
  const [screen, setScreen] = useState<'chat' | 'settings'>('chat')
  const [settingsSection, setSettingsSection] = useState<SectionId>('profile')
  const windowActive = useWindowActive()

  const settingsButton = useRef<HTMLButtonElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)

  const peer: PeerView | null = useMemo(() => {
    if (!snapshot?.settings.peerIp) return null
    const p = snapshot.peer
    return {
      name: p.name ?? 'Peer',
      ip: snapshot.settings.peerIp,
      presence: p.presence,
      lastSeen: p.lastSeen ? formatLastSeen(p.lastSeen) : undefined
    }
  }, [snapshot])

  // Read receipts: mark their messages read while the chat is actually on screen.
  useEffect(() => {
    if (!windowActive || screen !== 'chat') return
    const unread = messages.filter((m) => m.from === 'peer' && m.status !== 'read').map((m) => m.id)
    if (unread.length) markRead(unread)
  }, [messages, windowActive, screen, markRead])

  const openSettings = (section: SectionId = 'profile'): void => {
    setSettingsSection(section)
    setScreen('settings')
  }
  const openConnection = (): void => openSettings('connection')
  const closeSettings = useCallback(() => {
    setScreen('chat')
    requestAnimationFrame(() => settingsButton.current?.focus())
  }, [])

  // Esc closes settings (unless a popover inside already handled it).
  useEffect(() => {
    if (screen !== 'settings') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, closeSettings])

  if (!snapshot) {
    return <div className="scanlines h-full bg-app" aria-busy="true" />
  }

  return (
    <div className="scanlines flex h-full">
      {screen === 'settings' ? (
        <SettingsScreen
          settings={snapshot.settings}
          net={snapshot.net}
          peer={peer}
          onChange={hush.updateSettings}
          onReconnect={() => window.hush.reconnect()}
          onClose={closeSettings}
          initialSection={settingsSection}
        />
      ) : (
        <>
          <Sidebar
            peer={peer}
            myName={snapshot.settings.displayName}
            onOpenSettings={() => openSettings()}
            onLinkPeer={openConnection}
            settingsButtonRef={settingsButton}
          />
          <main className="hud-grid relative flex min-w-0 flex-1 flex-col bg-app">
            <ChatHeader peer={peer} />
            {!peer ? (
              <FirstRun ownIp={snapshot.net.ownIp} onOpenSettings={openConnection} />
            ) : messages.length === 0 && !hush.peerTyping ? (
              <EmptyChat peerName={peer.name} onSayHi={() => composer.current?.focus()} />
            ) : (
              <MessageList
                messages={messages}
                notices={hush.notices}
                peerName={peer.name}
                typing={hush.peerTyping}
                hasMore={hush.hasMore}
                loadingOlder={hush.loadingOlder}
                onLoadOlder={hush.loadOlder}
              />
            )}
            {hush.flush && peer && (
              <FlushToast key={hush.flush.id} text={deliveredText(hush.flush.count, peer.name)} onDone={hush.dismissFlush} />
            )}
            <Composer
              peerName={peer?.name ?? ''}
              disabled={!peer}
              onSend={hush.send}
              onTyping={(on) => window.hush.setTyping(on)}
              inputRef={composer}
            />
          </main>
        </>
      )}
      <LiveAnnouncer
        peerName={peer?.name ?? ''}
        typing={hush.peerTyping}
        lastIncomingId={lastIncomingId(messages)}
        flushText={hush.flush && peer ? deliveredText(hush.flush.count, peer.name) : null}
      />
    </div>
  )
}

function lastIncomingId(messages: ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].from === 'peer') return messages[i].id
  return null
}

/** The app's single polite status region (MASTER.md §7): typing and new messages. */
function LiveAnnouncer({
  peerName,
  typing,
  lastIncomingId,
  flushText
}: {
  peerName: string
  typing: boolean
  lastIncomingId: string | null
  flushText: string | null
}): ReactNode {
  const [text, setText] = useState('')
  useEffect(() => {
    if (flushText) setText(flushText)
  }, [flushText])
  const seen = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (typing) setText(`${peerName} is typing`)
  }, [typing, peerName])
  useEffect(() => {
    // Skip the history that is already there on startup; announce only new arrivals.
    if (seen.current !== undefined && lastIncomingId && lastIncomingId !== seen.current) setText(`New message from ${peerName}`)
    seen.current = lastIncomingId
  }, [lastIncomingId, peerName])
  return (
    <div role="status" aria-live="polite" className="sr-only">
      {text}
    </div>
  )
}

/** Short pop-up when the offline queue has been delivered (MASTER.md §6). Announced via LiveAnnouncer. */
function FlushToast({ text, onDone }: { text: string; onDone: () => void }): ReactNode {
  useEffect(() => {
    const t = setTimeout(onDone, 4000)
    return () => clearTimeout(t)
  }, [onDone])
  return (
    <div
      aria-hidden="true"
      className="cut panel panel-sm animate-rise pointer-events-none absolute top-[76px] left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 px-4 py-2.5 whitespace-nowrap [--edge-c:var(--online)] [--fill-c:var(--surface-elevated)]"
    >
      <CircleCheck className="size-4 text-online" />
      <span className="data text-text">{text}</span>
    </div>
  )
}
