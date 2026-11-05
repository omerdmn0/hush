import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso'
import type { ChatMessage } from '../../../../shared/types'
import { ArrowDown, CircleCheck, Phone, PhoneIncoming, PhoneMissed, PhoneOff, PhoneOutgoing } from 'lucide-react'
import type { CallRecord } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { callLogText } from '@/lib/callLogic'
import { cn } from '@/lib/utils'
import type { CallAction } from '@/lib/view'
import { formatTime } from '@/lib/format'
import { buildTimeline, lastQueuedId, type DeliveryNotice, type TimelineItem } from '@/lib/timeline'
import { Avatar } from '@/components/common'
import { MessageGroup, type ImageActions } from './MessageGroup'
import type { MessageActions } from './MessageActions'

const Column = ({ children }: { children: ReactNode }): ReactNode => (
  <div className="mx-auto max-w-[760px] px-6">{children}</div>
)

/**
 * Virtualized history (only visible rows are in the DOM — MASTER.md §7).
 * Sticks to the bottom when new messages arrive, unless the user scrolled up.
 */
export function MessageList({
  messages,
  notices,
  calls,
  callAction,
  peerName,
  typing,
  hasMore,
  loadingOlder,
  onLoadOlder,
  images,
  actions,
  newMarkerId,
  jumpRequest
}: {
  messages: ChatMessage[]
  notices: DeliveryNotice[]
  calls: CallRecord[]
  callAction: CallAction
  peerName: string
  typing: boolean
  hasMore: boolean
  loadingOlder: boolean
  onLoadOlder: () => void
  images: ImageActions
  /** Message actions from the app; jumping to a quoted message is handled here. */
  actions: Omit<MessageActions, 'onJump' | 'highlightId'>
  /** First message that arrived while you were away ("New messages" line). */
  newMarkerId: string | null
  /** Scroll to this message once it's loaded (search results); `n` makes repeats distinct. */
  jumpRequest: { id: string; n: number } | null
}): ReactNode {
  const items = useMemo(() => buildTimeline(messages, Date.now(), notices, calls, newMarkerId), [messages, notices, calls, newMarkerId])
  const list = useRef<VirtuosoHandle>(null)
  const itemsRef = useRef(items)
  itemsRef.current = items

  // Jump to the message a reply quotes, and flash it.
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const highlightTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(highlightTimer.current), [])
  const jumpTo = useCallback((id: string) => {
    const index = itemsRef.current.findIndex((it) => it.kind === 'group' && it.messages.some((m) => m.id === id))
    if (index < 0) return
    stick.current = false
    list.current?.scrollToIndex({ index, align: 'center', behavior: 'smooth' })
    setHighlightId(id)
    clearTimeout(highlightTimer.current)
    highlightTimer.current = setTimeout(() => setHighlightId(null), 1600)
  }, [])
  const allActions: MessageActions = useMemo(() => ({ ...actions, onJump: jumpTo, highlightId }), [actions, jumpTo, highlightId])
  const handledJump = useRef(0)
  useEffect(() => {
    if (!jumpRequest || jumpRequest.n === handledJump.current) return
    if (!items.some((it) => it.kind === 'group' && it.messages.some((m) => m.id === jumpRequest.id))) return // not loaded yet
    handledJump.current = jumpRequest.n
    // Let Virtuoso take in newly loaded history before scrolling.
    requestAnimationFrame(() => jumpTo(jumpRequest.id))
  }, [jumpRequest, items, jumpTo])

  // Virtuoso keeps the scroll position on prepend when firstItemIndex drops by exactly the
  // number of prepended items. Recomputed idempotently during render (StrictMode-safe).
  const firstIndex = useRef(FIRST_INDEX)
  const prev = useRef<{ oldestId: string | undefined; count: number }>({ oldestId: messages[0]?.id, count: items.length })
  if (messages[0]?.id !== prev.current.oldestId && prev.current.count > 0) {
    firstIndex.current -= Math.max(0, items.length - prev.current.count)
  }
  prev.current = { oldestId: messages[0]?.id, count: items.length }
  const noteAfter = useMemo(() => lastQueuedId(messages), [messages])
  const scroller = useRef<HTMLElement | null>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  // "Stick to bottom" follows the user's own scrolling only. Layout changes (typing indicator,
  // call bar opening) don't fire scroll events, so they can't accidentally unstick the view.
  const stick = useRef(true)

  const pinToBottom = (): void => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }
  // Scrolled up: a "Jump to latest" button counts what arrived since.
  const [awayFrom, setAwayFrom] = useState<string | null>(null)
  const lastId = useRef<string | undefined>(undefined)
  lastId.current = messages[messages.length - 1]?.id
  const onScroll = (): void => {
    const el = scroller.current
    if (!el) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    const away = el.scrollHeight - el.scrollTop - el.clientHeight > 300
    setAwayFrom((prev) => (away ? (prev ?? lastId.current ?? null) : null))
  }
  const newSince = awayFrom ? messages.length - 1 - messages.findIndex((m) => m.id === awayFrom) : 0
  const jumpToLatest = (): void => {
    stick.current = true
    setAwayFrom(null)
    list.current?.scrollToIndex({ index: items.length - 1, align: 'end', behavior: 'smooth' })
  }
  useEffect(() => {
    if (typing) pinToBottom()
  }, [typing])
  useEffect(() => {
    const el = wrapper.current
    if (!el) return
    const ro = new ResizeObserver(pinToBottom)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  return (
    // role=log without live announcements: virtualization adds/removes rows while scrolling,
    // so new-message announcements go through the app's single status region instead.
    <div ref={wrapper} role="log" aria-live="off" aria-label={`Messages with ${peerName}`} className="relative min-h-0 flex-1">
      <Virtuoso<TimelineItem, ListContext>
        ref={list}
        className="h-full"
        scrollerRef={(el) => {
          scroller.current?.removeEventListener('scroll', onScroll)
          scroller.current = el instanceof HTMLElement ? el : null
          scroller.current?.addEventListener('scroll', onScroll, { passive: true })
        }}
        data={items}
        context={{ typing, peerName, hasMore, loadingOlder }}
        firstItemIndex={firstIndex.current}
        startReached={() => hasMore && onLoadOlder()}
        computeItemKey={(_, item) => item.key}
        initialTopMostItemIndex={{ index: 'LAST', align: 'end' }}
        alignToBottom
        followOutput={() => (stick.current ? 'smooth' : false)}
        increaseViewportBy={{ top: 400, bottom: 200 }}
        itemContent={(_, item) => (
          <Column>
            {item.kind === 'day' ? (
              <div className="rule pt-[22px] pb-1.5">
                <span className="label">{item.label}</span>
              </div>
            ) : item.kind === 'notice' ? (
              <NoticeLine notice={item.notice} peerName={peerName} />
            ) : item.kind === 'call' ? (
              <CallLine call={item.call} peerName={peerName} callAction={callAction} />
            ) : item.kind === 'new' ? (
              <div className="rule pt-[18px] [--rule-c:color-mix(in_srgb,var(--magenta)_55%,transparent)]">
                <span className="label text-magenta">New messages</span>
              </div>
            ) : (
              <MessageGroup
                from={item.from}
                messages={item.messages}
                peerName={peerName}
                queuedNoteAfter={noteAfter}
                images={images}
                actions={allActions}
              />
            )}
          </Column>
        )}
        components={COMPONENTS}
      />
      {awayFrom !== null && (
        <Button variant="secondary" size="sm" onClick={jumpToLatest} className="absolute right-6 bottom-3 z-20 shadow-[0_4px_16px_rgba(0,0,0,.5)]">
          <ArrowDown />
          {newSince > 0 ? `${newSince} new · Jump to latest` : 'Jump to latest'}
        </Button>
      )}
    </div>
  )
}

const FIRST_INDEX = 1_000_000

interface ListContext {
  typing: boolean
  peerName: string
  hasMore: boolean
  loadingOlder: boolean
}

// Stable component identities, so Virtuoso doesn't remount header/footer on every render.
const COMPONENTS = {
  Header: ({ context }: { context?: ListContext }): ReactNode =>
    context?.loadingOlder || !context?.hasMore ? (
      <Column>
        <div className="rule pt-4 pb-1">
          <span className="label">{context?.loadingOlder ? 'Loading history…' : 'Start of your history'}</span>
        </div>
      </Column>
    ) : (
      <div className="h-2" />
    ),
  Footer: ({ context }: { context?: ListContext }): ReactNode => (
    <Column>
      {context?.typing && <TypingIndicator peerName={context.peerName} />}
      <div className="h-4" />
    </Column>
  )
}

export function deliveredText(count: number, peerName?: string): string {
  return `${count} queued message${count === 1 ? '' : 's'} delivered${peerName ? ` to ${peerName}` : ''}`
}

function NoticeLine({ notice, peerName }: { notice: DeliveryNotice; peerName: string }): ReactNode {
  return (
    <div className="rule animate-rise pt-[18px] [--rule-c:color-mix(in_srgb,var(--online)_45%,transparent)]">
      <span className="label inline-flex items-center gap-1.5 text-online">
        <CircleCheck aria-hidden="true" className="size-3.5" />
        {deliveredText(notice.count)} · {formatTime(notice.at)}
        <span className="sr-only"> to {peerName}</span>
      </span>
    </div>
  )
}

function CallLine({ call, peerName, callAction }: { call: CallRecord; peerName: string; callAction: CallAction }): ReactNode {
  const missed = call.outcome === 'missed'
  const done = call.outcome === 'completed' || call.outcome === 'ongoing'
  const Icon = missed ? PhoneMissed : !done ? PhoneOff : call.direction === 'out' ? PhoneOutgoing : PhoneIncoming
  return (
    <div className={cn('rule pt-[18px]', missed && '[--rule-c:color-mix(in_srgb,var(--danger-text)_45%,transparent)]')}>
      <span className={cn('label inline-flex items-center gap-1.5', missed ? 'text-danger-text' : done ? 'text-cyan' : 'text-text-muted')}>
        <Icon aria-hidden="true" className="size-3.5" />
        {callLogText(call, peerName)} · {formatTime(call.startedAt)}
      </span>
      {missed && (
        <Button
          variant="secondary"
          size="sm"
          className="h-7"
          aria-disabled={!callAction.enabled}
          aria-label={callAction.enabled ? `Call ${peerName} back` : `Call back (${callAction.hint})`}
          title={callAction.enabled ? undefined : callAction.hint}
          onClick={() => callAction.enabled && callAction.onCall()}
        >
          <Phone />
          Call back
        </Button>
      )}
    </div>
  )
}

function TypingIndicator({ peerName }: { peerName: string }): ReactNode {
  return (
    <div className="flex gap-2.5 pt-4">
      <Avatar name={peerName} who="peer" size={32} />
      <div className="flex flex-col items-start">
        <div aria-hidden="true" className="cut shape-theirs inline-flex gap-[5px] px-3.5 pt-3.5 pb-[13px]">
          {[0, 0.2, 0.4].map((d) => (
            <i key={d} className="size-[7px] animate-blink bg-cyan" style={{ animationDelay: `${d}s` }} />
          ))}
        </div>
        <div className="data mt-1 ml-0.5 text-text-muted">
          {peerName} is typing<span aria-hidden="true" className="animate-caret">_</span>
        </div>
      </div>
    </div>
  )
}
