import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import type { ChatMessage } from '../../shared/types'
import { Sidebar } from '@/components/Sidebar'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { CallBar } from '@/components/chat/CallBar'
import { MessageList } from '@/components/chat/MessageList'
import { Composer } from '@/components/chat/Composer'
import { EmptyChat, FirstRun } from '@/components/chat/EmptyStates'
import { SettingsScreen, type SectionId, type Settings } from '@/components/settings/SettingsScreen'
import { DEMO_PEER, demoMessages } from '@/lib/demo'
import type { PeerView } from '@/lib/view'

interface CallState {
  startedAt: number
  muted: boolean
}

export default function App(): ReactNode {
  const [screen, setScreen] = useState<'chat' | 'settings'>('chat')
  const [settingsSection, setSettingsSection] = useState<SectionId>('profile')
  // Settings live in memory for now; they are saved to disk from stage b on.
  const [settings, setSettings] = useState<Settings>({ displayName: '', peerIp: '', notifications: true })
  const [ownIp, setOwnIp] = useState<string | null | undefined>(undefined)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [call, setCall] = useState<CallState | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [demo, setDemo] = useState(false)
  const [demoOnline, setDemoOnline] = useState(false)
  const [typing, setTyping] = useState(false)

  const settingsButton = useRef<HTMLButtonElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(typingTimer.current), [])

  const refreshOwnIp = useCallback(() => {
    setOwnIp(undefined)
    window.hush.getTailscaleIp().then(setOwnIp, () => setOwnIp(null))
  }, [])
  useEffect(refreshOwnIp, [refreshOwnIp])

  const peer: PeerView | null = demo
    ? { ...DEMO_PEER, presence: demoOnline ? 'online' : 'offline', lastSeen: '13:11' }
    : settings.peerIp
      ? { name: 'Peer', ip: settings.peerIp, presence: 'offline' }
      : null
  const peerOnline = peer?.presence === 'online'

  const openSettings = (section: SectionId = 'profile'): void => {
    setSettingsSection(section)
    setScreen('settings')
  }
  const openConnection = (): void => openSettings('connection')
  const closeSettings = useCallback(() => {
    setScreen('chat')
    requestAnimationFrame(() => settingsButton.current?.focus())
  }, [])

  const send = (text: string): void => {
    const m: ChatMessage = { id: crypto.randomUUID(), from: 'me', text, sentAt: Date.now(), status: peerOnline ? 'sent' : 'queued' }
    setMessages((prev) => [...prev, m])
    if (demo && peerOnline) {
      setTimeout(() => setMessages((prev) => prev.map((x) => (x.id === m.id ? { ...x, status: 'delivered' } : x))), 700)
    }
  }

  const startCall = (): void => {
    if (!peerOnline || call) return
    setCall({ startedAt: Date.now(), muted: false })
    setAnnouncement(`Call with ${peer?.name} started`)
  }
  const hangUp = (): void => {
    setCall(null)
    setAnnouncement('Call ended')
  }

  // Esc closes settings (unless a popover inside already handled it).
  useEffect(() => {
    if (screen !== 'settings') return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.defaultPrevented) closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [screen, closeSettings])

  // Development-only preview shortcuts: Ctrl+Shift+D sample chat, O peer online/offline, C call bar.
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || !e.shiftKey) return
      const k = e.key.toLowerCase()
      if (k === 'd') {
        e.preventDefault()
        setDemo(!demo)
        setMessages(demo ? [] : demoMessages())
        setDemoOnline(false)
        setTyping(false)
        setCall(null)
      } else if (k === 'o' && demo) {
        e.preventDefault()
        setDemoOnline(!demoOnline)
        if (!demoOnline) {
          const queued = messages.filter((m) => m.status === 'queued').length
          setMessages(messages.map((m) => (m.status === 'queued' ? { ...m, status: 'delivered' } : m)))
          if (queued > 0) setAnnouncement(`${queued} queued messages delivered to ${DEMO_PEER.name}`)
          clearTimeout(typingTimer.current)
          typingTimer.current = setTimeout(() => {
            setTyping(true)
            setAnnouncement(`${DEMO_PEER.name} is typing`)
          }, 1400)
        } else {
          clearTimeout(typingTimer.current)
          setTyping(false)
          setCall(null)
        }
      } else if (k === 'c' && demo) {
        e.preventDefault()
        setCall(call ? null : { startedAt: Date.now() - 763_000, muted: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [demo, demoOnline, messages, call])

  return (
    <div className="scanlines flex h-full">
      {screen === 'settings' ? (
        <SettingsScreen
          settings={settings}
          onChange={(patch) => setSettings((s) => ({ ...s, ...patch }))}
          ownIp={ownIp}
          onRefreshOwnIp={refreshOwnIp}
          onClose={closeSettings}
          initialSection={settingsSection}
        />
      ) : (
        <>
          <Sidebar
            peer={peer}
            myName={settings.displayName}
            inCall={call !== null}
            onCall={startCall}
            onOpenSettings={() => openSettings()}
            onLinkPeer={openConnection}
            settingsButtonRef={settingsButton}
          />
          <main className="hud-grid relative flex min-w-0 flex-1 flex-col bg-app">
            <ChatHeader peer={peer} inCall={call !== null} onCall={startCall} />
            {call && peer && (
              <CallBar
                peerName={peer.name}
                startedAt={call.startedAt}
                micLabel="System default"
                muted={call.muted}
                onToggleMute={() => setCall((c) => c && { ...c, muted: !c.muted })}
                onHangUp={hangUp}
              />
            )}
            {!peer ? (
              <FirstRun ownIp={ownIp} onOpenSettings={openConnection} />
            ) : messages.length === 0 ? (
              <EmptyChat peerName={peer.name} onSayHi={() => composer.current?.focus()} />
            ) : (
              <MessageList messages={messages} peerName={peer.name} typing={typing} />
            )}
            <Composer peerName={peer?.name ?? ''} disabled={!peer} onSend={send} inputRef={composer} />
          </main>
        </>
      )}
      <div role="status" aria-live="polite" className="sr-only">
        {announcement}
      </div>
    </div>
  )
}
