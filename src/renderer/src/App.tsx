import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage } from '../../shared/types'
import { Sidebar } from '@/components/Sidebar'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { CircleCheck, ImagePlus } from 'lucide-react'
import { deliveredText, MessageList } from '@/components/chat/MessageList'
import { Composer, type ComposerHandle } from '@/components/chat/Composer'
import { Lightbox } from '@/components/chat/Lightbox'
import type { ImageActions } from '@/components/chat/MessageGroup'
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
  const composerHandle = useRef<ComposerHandle>(null)
  const [viewing, setViewing] = useState<ChatMessage | null>(null)
  // The thumbnail that opened the viewer, so focus can go back to it (MASTER.md §7).
  const viewerOpener = useRef<HTMLElement | null>(null)
  const openViewer = useCallback((m: ChatMessage) => {
    viewerOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setViewing(m)
  }, [])
  const restoreFocus = useCallback(() => {
    const el = viewerOpener.current
    ;(el?.isConnected ? el : composer.current)?.focus()
  }, [])
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  // Never let a file dropped anywhere navigate the window to it.
  useEffect(() => {
    const block = (e: DragEvent): void => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const { transfers, retryImage } = hush
  const imageActions: ImageActions = useMemo(
    () => ({ transfers, onOpen: openViewer, onRetry: retryImage }),
    [transfers, openViewer, retryImage]
  )

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
          <main
            className="hud-grid relative flex min-w-0 flex-1 flex-col bg-app"
            onDragEnter={(e) => {
              if (!peer || !e.dataTransfer.types.includes('Files')) return
              dragDepth.current++
              setDragging(true)
            }}
            onDragLeave={() => {
              if (dragDepth.current > 0 && --dragDepth.current === 0) setDragging(false)
            }}
            onDragOver={(e) => {
              if (!peer) return
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
            }}
            onDrop={(e) => {
              e.preventDefault()
              dragDepth.current = 0
              setDragging(false)
              if (peer) composerHandle.current?.addFiles([...e.dataTransfer.files])
            }}
          >
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
                images={imageActions}
              />
            )}
            {hush.flush && peer && (
              <FlushToast key={hush.flush.id} text={deliveredText(hush.flush.count, peer.name)} onDone={hush.dismissFlush} />
            )}
            <Composer
              peerName={peer?.name ?? ''}
              disabled={!peer}
              onSend={hush.send}
              onSendImage={hush.sendImage}
              onTyping={(on) => window.hush.setTyping(on)}
              inputRef={composer}
              handleRef={composerHandle}
            />
            {dragging && peer && <DropZone peerName={peer.name} />}
          </main>
        </>
      )}
      <Lightbox
        message={viewing && (messages.find((m) => m.id === viewing.id) ?? viewing)}
        peerName={peer?.name ?? 'Peer'}
        onClose={() => setViewing(null)}
        onClosed={restoreFocus}
      />
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

/** Overlay while files are dragged over the chat (MASTER.md states gallery). */
function DropZone({ peerName }: { peerName: string }): ReactNode {
  return (
    <div className="pointer-events-none absolute inset-2 z-40 grid place-items-center border-2 border-dashed border-cyan bg-[color-mix(in_srgb,var(--bg-app)_88%,var(--cyan))] text-center">
      <div>
        <ImagePlus aria-hidden="true" className="mx-auto mb-1.5 size-7 text-cyan" />
        <div className="label text-cyan">Drop to send to {peerName}</div>
        <div className="text-xs text-text-muted">PNG, JPEG, GIF or WebP · up to 25 MB · you can add a caption first</div>
      </div>
    </div>
  )
}
