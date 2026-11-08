import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { GENERAL_CHANNEL } from '../../shared/protocol'
import type { CallRecord, ChatMessage, SearchResult } from '../../shared/types'
import { Sidebar } from '@/components/Sidebar'
import { NewChannelDialog } from '@/components/NewChannelDialog'
import { QuitDialog } from '@/components/QuitDialog'
import { PairingScreen } from '@/components/PairingScreen'
import { AvatarContext } from '@/components/common'
import { ChatHeader } from '@/components/chat/ChatHeader'
import { CircleAlert, CircleCheck, ImagePlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { CallBar } from '@/components/chat/CallBar'
import { IncomingCall } from '@/components/chat/IncomingCall'
import { deliveredText, MessageList } from '@/components/chat/MessageList'
import { Composer, pruneDrafts, type ComposerHandle, type ComposerMode } from '@/components/chat/Composer'
import { DeleteDialog, type MessageActions } from '@/components/chat/MessageActions'
import { SearchPanel } from '@/components/chat/SearchPanel'
import { ScreenView } from '@/components/chat/ScreenView'
import { ShareDialog } from '@/components/chat/ShareDialog'
import { Lightbox } from '@/components/chat/Lightbox'
import type { ImageActions } from '@/components/chat/MessageGroup'
import { EmptyChat, FirstRun } from '@/components/chat/EmptyStates'
import { SettingsScreen, type SectionId } from '@/components/settings/SettingsScreen'
import { formatLastSeen } from '@/lib/format'
import { captureScreen, type ShareChoice } from '@/lib/screenShare'
import { isNewer } from '@/lib/version'
import type { DeliveryNotice } from '@/lib/timeline'
import type { CallView } from '@/lib/call'
import { useAudioDevices } from '@/lib/useAudioDevices'
import { useCall } from '@/lib/useCall'
import { useHush } from '@/lib/useHush'
import type { CallAction, PeerView } from '@/lib/view'

/** Calls and delivery notices aren't part of any channel, so they appear in General only. */
const NO_CALLS: CallRecord[] = []
const NO_NOTICES: DeliveryNotice[] = []

export default function App(): ReactNode {
  const hush = useHush()
  const { snapshot, messages, markRead, channel } = hush
  const inGeneral = channel === GENERAL_CHANNEL
  const [screen, setScreen] = useState<'chat' | 'settings'>('chat')
  const [settingsSection, setSettingsSection] = useState<SectionId>('profile')
  // Visible + focused, as reported by the main process (reliable even when hidden in the tray).
  const windowActive = snapshot?.windowActive ?? false

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
  const [quitOpen, setQuitOpen] = useState(false)
  // Ctrl+Q asks to quit (the window's close button only hides Hush to the tray).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'q') {
        e.preventDefault()
        setQuitOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
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

  // Saving is the only way an attachment leaves Hush; a short notice offers "Show in folder".
  const [saved, setSaved] = useState<{ path?: string; error?: string; n: number } | null>(null)
  const saveAttachment = useCallback((m: ChatMessage) => {
    void window.hush.saveAttachment(m.id).then((r) => {
      if ('saved' in r) setSaved((p) => ({ path: r.saved, n: (p?.n ?? 0) + 1 }))
      else if ('error' in r) setSaved((p) => ({ error: r.error, n: (p?.n ?? 0) + 1 }))
    })
  }, [])
  const oldestLoaded = messages[0]?.sentAt
  const shownCalls = useMemo(() => visibleCalls(hush.calls, oldestLoaded, hush.hasMore), [hush.calls, oldestLoaded, hush.hasMore])
  const { retryImage } = hush
  const imageActions: ImageActions = useMemo(
    () => ({ onOpen: openViewer, onRetry: retryImage, onDownload: retryImage, onSave: saveAttachment }),
    [openViewer, retryImage, saveAttachment]
  )

  const peer: PeerView | null = useMemo(() => {
    if (!snapshot?.settings.peerIp) return null
    const p = snapshot.peer
    return {
      name: p.name ?? snapshot.pairing.peerName ?? 'Peer',
      ip: snapshot.settings.peerIp,
      presence: p.presence,
      lastSeen: p.lastSeen ? formatLastSeen(p.lastSeen) : undefined
    }
  }, [snapshot])

  const { view: callView, call } = useCall({
    peerName: peer?.name ?? 'Peer',
    peerOnline: peer?.presence === 'online',
    micId: snapshot?.settings.micId ?? '',
    speakerId: snapshot?.settings.speakerId ?? '',
    devPairing: snapshot?.devPairing ?? false,
    peerCanShare: snapshot?.peer.canShare ?? false
  })
  const [shareOpen, setShareOpen] = useState(false)
  const [shareNotice, setShareNotice] = useState<string | null>(null)
  const startShare = (choice: ShareChoice): void => {
    setShareOpen(false)
    setShareNotice(null)
    captureScreen(choice)
      .then(async (capture) => {
        await call.startShare(capture)
        if (capture.audioError) setShareNotice(`Sharing without sound: ${capture.audioError}`)
      })
      .catch((e: unknown) => {
        // Pressing Cancel in the system's prompt isn't an error.
        if ((e as Error).name !== 'NotAllowedError') setShareNotice("Couldn't share your screen.")
      })
  }
  const { mics } = useAudioDevices()
  const callBusy = call.busy
  const callAction: CallAction = useMemo(
    () => ({
      enabled: peer?.presence === 'online' && !callBusy,
      hint: !peer
        ? 'No one linked yet'
        : peer.presence !== 'online'
          ? `${peer.name} is offline`
          : callBusy
            ? 'Already in a call'
            : `Call ${peer.name}`,
      onCall: () => void call.start()
    }),
    [peer?.presence, peer?.name, callBusy, call]
  )

  // Read receipts: mark their messages read while the chat is actually on screen. Coming back
  // to the chat (or opening Hush) with unread messages puts a "New messages" line above them.
  const [newMarker, setNewMarker] = useState<string | null>(null)
  const wasActive = useRef(false)
  const markedChannel = useRef(channel)
  const loaded = snapshot !== null
  useEffect(() => {
    if (!loaded) return
    if (!windowActive || screen !== 'chat') {
      wasActive.current = false
      return
    }
    const unread = messages.filter((m) => m.from === 'peer' && m.status !== 'read').map((m) => m.id)
    if (!wasActive.current || markedChannel.current !== channel) {
      wasActive.current = true
      markedChannel.current = channel
      setNewMarker(unread[0] ?? null)
    }
    if (unread.length) markRead(unread)
  }, [loaded, messages, windowActive, screen, markRead, channel])

  // Search (Ctrl+F or the header button); picking a result loads history up to it and scrolls there.
  const [searchOpen, setSearchOpen] = useState(false)
  const searchButton = useRef<HTMLButtonElement>(null)
  const [jumpRequest, setJumpRequest] = useState<{ id: string; n: number; channel: string } | null>(null)
  const canSearch = screen === 'chat' && !!snapshot?.settings.peerIp && snapshot.pairing.status === 'paired'
  useEffect(() => {
    if (!canSearch) return
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canSearch])
  const closeSearch = useCallback(() => {
    setSearchOpen(false)
    requestAnimationFrame(() => searchButton.current?.focus())
  }, [])
  const { reveal, switchChannel } = hush
  const pickResult = useCallback(
    (r: SearchResult) => {
      const target = r.channel ?? GENERAL_CHANNEL
      const request = (prev: { n: number } | null): { id: string; n: number; channel: string } => ({ id: r.id, n: (prev?.n ?? 0) + 1, channel: target })
      if (target === channel) {
        void reveal(r.id, r.sentAt).then((found) => found && setJumpRequest(request))
      } else {
        setJumpRequest(request) // in place first: the new channel's list opens on it
        void switchChannel(target, r)
      }
    },
    [reveal, switchChannel, channel]
  )
  const [newChannelOpen, setNewChannelOpen] = useState(false)

  // Reply / edit / delete / react
  const [composerMode, setComposerMode] = useState<ComposerMode | null>(null)
  const [deleting, setDeleting] = useState<ChatMessage | null>(null)
  // Whatever was tied to the old channel's messages goes before anything renders against the new
  // one. A search jump aimed at the new channel can land in the same update, so it stays.
  const [shownChannel, setShownChannel] = useState(channel)
  if (shownChannel !== channel) {
    setShownChannel(channel)
    setComposerMode(null)
    setViewing(null)
    setDeleting(null)
    if (jumpRequest?.channel !== channel) setJumpRequest(null)
  }
  const canWrite = !!snapshot && snapshot.pairing.status === 'paired' && !snapshot.peer.catchingUp
  const channelList = snapshot?.channels
  useEffect(() => {
    if (channelList) pruneDrafts(new Set(channelList.map((c) => c.id)))
  }, [channelList])
  const messageActions: Omit<MessageActions, 'onJump' | 'highlightId'> = useMemo(
    () => ({
      onReply: (m) => setComposerMode({ kind: 'reply', message: m }),
      onEdit: (m) => setComposerMode({ kind: 'edit', message: m }),
      onDelete: (m) => setDeleting(m),
      onReact: (m, emoji, on) => void window.hush.react(m.id, emoji, on).catch(() => {}),
      onSave: saveAttachment,
      canWrite
    }),
    [canWrite, saveAttachment]
  )
  const editLast = (): void => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]
      if (m.from === 'me' && !m.deleted && !m.unsupported) return setComposerMode({ kind: 'edit', message: m })
    }
  }
  const send = useCallback(
    async (text: string, replyTo?: string) => {
      setNewMarker(null)
      await hush.send(text, replyTo, channel)
    },
    [hush.send, channel]
  )

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

  const paired = !!peer && snapshot.pairing.status === 'paired'
  const channelName = snapshot.channels.find((c) => c.id === channel)?.name

  return (
    <AvatarContext.Provider value={snapshot.avatars}>
    <div className="scanlines flex h-full">
      {screen === 'settings' ? (
        <SettingsScreen
          settings={snapshot.settings}
          net={snapshot.net}
          peer={peer}
          pairing={snapshot.pairing}
          privacy={snapshot.privacy}
          packaged={snapshot.packaged}
          appVersion={snapshot.appVersion}
          onChange={hush.updateSettings}
          onReconnect={() => window.hush.reconnect()}
          onClose={closeSettings}
          initialSection={settingsSection}
        />
      ) : (
        <>
          <Sidebar
            peer={peer}
            channels={paired ? snapshot.channels : null}
            unread={snapshot.unread}
            activeChannel={channel}
            onSelectChannel={(id) => void switchChannel(id)}
            onNewChannel={() => setNewChannelOpen(true)}
            newChannelBlocked={
              !snapshot.peer.channelsReady ? 'Channels need both computers on the latest Hush' : !canWrite ? 'Hush is still catching up' : null
            }
            myName={snapshot.settings.displayName}
            call={callAction}
            onOpenSettings={() => openSettings()}
            onLinkPeer={openConnection}
            paired={snapshot.pairing.status === 'paired'}
            updateHint={peer && snapshot.peer.appVersion && isNewer(snapshot.peer.appVersion, snapshot.appVersion) ? `${peer.name} has Hush ${snapshot.peer.appVersion} — update for new features` : null}
            onQuit={() => setQuitOpen(true)}
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
            <ChatHeader
              peer={peer}
              channelName={paired ? channelName : undefined}
              call={callAction}
              onSearch={canSearch ? () => setSearchOpen((o) => !o) : undefined}
              searchOpen={searchOpen}
              searchButtonRef={searchButton}
            />
            {searchOpen && canSearch && peer && <SearchPanel peerName={peer.name} channels={snapshot.channels} onPick={pickResult} onClose={closeSearch} />}
            {peer && (
              <CallBar
                view={callView}
                peerName={peer.name}
                mics={mics}
                micId={snapshot.settings.micId}
                onMicChange={(micId) => {
                  void hush.updateSettings({ micId })
                  void call.switchMic(micId)
                }}
                onToggleMute={() => call.toggleMute()}
                onHangUp={() => call.hangUp()}
                onShare={() => setShareOpen(true)}
                onStopShare={() => (setShareNotice(null), void call.stopShare())}
                shareNotice={shareNotice}
              />
            )}
            {peer && callView.peerSharing && call.remoteScreen && (
              <ScreenView stream={call.remoteScreen} peerName={peer.name} audio={callView.peerSharing.audio} speakerId={snapshot.settings.speakerId} />
            )}
            {!peer ? (
              <FirstRun ownIp={snapshot.net.ownIp} onOpenSettings={openConnection} />
            ) : snapshot.pairing.status !== 'paired' ? (
              <PairingScreen pairing={snapshot.pairing} peerName={peer.name} />
            ) : messages.length === 0 && (!inGeneral || hush.calls.length === 0) && !hush.peerTyping ? (
              <EmptyChat peerName={peer.name} onSayHi={() => composer.current?.focus()} />
            ) : (
              <MessageList
                key={`list:${channel}`}
                messages={messages}
                notices={inGeneral ? hush.notices : NO_NOTICES}
                calls={inGeneral ? shownCalls : NO_CALLS}
                callAction={callAction}
                peerName={peer.name}
                typing={hush.peerTyping}
                hasMore={hush.hasMore}
                loadingOlder={hush.loadingOlder}
                onLoadOlder={hush.loadOlder}
                images={imageActions}
                actions={messageActions}
                newMarkerId={newMarker}
                jumpRequest={jumpRequest}
              />
            )}
            {hush.flush && peer && (
              <FlushToast key={hush.flush.id} text={deliveredText(hush.flush.count, peer.name)} onDone={hush.dismissFlush} />
            )}
            <Composer
              key={`composer:${channel}`}
              channel={channel}
              channelName={inGeneral ? undefined : channelName}
              peerName={peer?.name ?? ''}
              disabled={!peer || snapshot.pairing.status !== 'paired' || snapshot.peer.catchingUp}
              disabledHint={
                !peer
                  ? 'Link someone in settings to start chatting'
                  : snapshot.pairing.status !== 'paired'
                    ? 'Pair first — exchange the codes above'
                    : `Backup restored — you can write once ${peer.name} is online and Hush has caught up`
              }
              onSend={send}
              onSendImage={(image, caption, replyTo) => hush.sendImage(image, caption, replyTo, channel)}
              mode={composerMode}
              onCancelMode={() => setComposerMode(null)}
              onEdit={(id, text) => window.hush.editMessage(id, text)}
              onEditLast={editLast}
              onSendFile={async (file, caption, replyTo) => {
                setNewMarker(null)
                await window.hush.sendFile(file, caption, replyTo, channel)
              }}
              onSendVoice={async (note, replyTo) => {
                setNewMarker(null)
                await window.hush.sendVoice(note.bytes, note.durationMs, note.peaks, replyTo, channel)
              }}
              micId={snapshot.settings.micId}
              onTyping={(on) => window.hush.setTyping(on, channel)}
              inputRef={composer}
              handleRef={composerHandle}
            />
            {dragging && peer && <DropZone peerName={peer.name} />}
          </main>
        </>
      )}
      <ShareDialog open={shareOpen} peerName={peer?.name ?? 'Peer'} onClose={() => setShareOpen(false)} onStart={startShare} />
      <DeleteDialog message={deleting} peerName={peer?.name ?? 'Peer'} onClose={() => setDeleting(null)} />
      <QuitDialog open={quitOpen} onOpenChange={setQuitOpen} inCall={call.busy} peerName={peer?.name ?? 'Peer'} />
      <NewChannelDialog
        open={newChannelOpen}
        onOpenChange={setNewChannelOpen}
        onCreated={(c) => {
          setNewChannelOpen(false)
          void switchChannel(c.id)
        }}
      />
      <IncomingCall
        open={callView.phase === 'incoming'}
        peerName={peer?.name ?? 'Peer'}
        onAccept={() => void call.accept()}
        onDecline={() => call.decline()}
      />
      <Lightbox
        message={viewing && (messages.find((m) => m.id === viewing.id) ?? viewing)}
        peerName={peer?.name ?? 'Peer'}
        onClose={() => setViewing(null)}
        onClosed={restoreFocus}
        onSave={saveAttachment}
      />
      {saved && <SavedNotice key={saved.n} path={saved.path} error={saved.error} onDone={() => setSaved(null)} />}
      <LiveAnnouncer
        key={channel}
        peerName={peer?.name ?? ''}
        typing={hush.peerTyping}
        lastIncomingId={lastIncomingId(messages)}
        flushText={hush.flush && peer ? deliveredText(hush.flush.count, peer.name) : null}
        callText={callAnnouncement(callView, peer?.name ?? 'Peer')}
      />
    </div>
    </AvatarContext.Provider>
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
  flushText,
  callText
}: {
  peerName: string
  typing: boolean
  lastIncomingId: string | null
  flushText: string | null
  callText: string | null
}): ReactNode {
  const [text, setText] = useState('')
  useEffect(() => {
    if (callText) setText(callText)
  }, [callText])
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

/** "Saved · Show in folder" after saving an attachment (or why it failed). */
function SavedNotice({ path, error, onDone }: { path?: string; error?: string; onDone: () => void }): ReactNode {
  useEffect(() => {
    const t = setTimeout(onDone, 7000)
    return () => clearTimeout(t)
  }, [onDone])
  const name = path?.split(/[\\/]/).pop()
  return (
    <div
      role="status"
      className="cut panel panel-sm animate-rise fixed bottom-24 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 px-4 py-2.5 [--edge-c:var(--online)] [--fill-c:var(--surface-elevated)]"
    >
      {error ? <CircleAlert aria-hidden="true" className="size-4 text-danger-text" /> : <CircleCheck aria-hidden="true" className="size-4 text-online" />}
      <span className="max-w-[340px] truncate text-sm">{error ? `Couldn't save: ${error}` : `Saved “${name}”`}</span>
      {path && (
        <Button variant="secondary" size="sm" onClick={() => window.hush.showInFolder(path)}>
          Show in folder
        </Button>
      )}
      <Button variant="icon" size="icon" className="size-7" aria-label="Dismiss" onClick={onDone}>
        <X className="size-4" />
      </Button>
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
        <div className="text-xs text-text-muted">Pictures up to 25 MB get a preview · any file up to 1 GB · you can add a caption first</div>
      </div>
    </div>
  )
}

function callAnnouncement(v: CallView, peerName: string): string | null {
  switch (v.phase) {
    case 'incoming':
      return `${peerName} is calling`
    case 'active':
      return `Call with ${peerName} connected`
    case 'ended':
      return v.endedText
    default:
      return null
  }
}

/** Calls older than the loaded part of history appear once paging reaches them. */
function visibleCalls(calls: CallRecord[], oldest: number | undefined, hasMore: boolean): CallRecord[] {
  if (!hasMore || oldest === undefined) return calls
  return calls.filter((c) => c.startedAt >= oldest)
}
