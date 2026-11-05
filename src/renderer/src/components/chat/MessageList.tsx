import { useEffect, useMemo, useRef, type ReactNode } from 'react'
import { Virtuoso } from 'react-virtuoso'
import type { ChatMessage } from '../../../../shared/types'
import { buildTimeline, lastQueuedId, type TimelineItem } from '@/lib/timeline'
import { Avatar } from '@/components/common'
import { MessageGroup } from './MessageGroup'

const Column = ({ children }: { children: ReactNode }): ReactNode => (
  <div className="mx-auto max-w-[760px] px-6">{children}</div>
)

/**
 * Virtualized history (only visible rows are in the DOM — MASTER.md §7).
 * Sticks to the bottom when new messages arrive, unless the user scrolled up.
 */
export function MessageList({
  messages,
  peerName,
  typing
}: {
  messages: ChatMessage[]
  peerName: string
  typing: boolean
}): ReactNode {
  const items = useMemo(() => buildTimeline(messages), [messages])
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
  const onScroll = (): void => {
    const el = scroller.current
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
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
    <div ref={wrapper} role="log" aria-live="off" aria-label={`Messages with ${peerName}`} className="min-h-0 flex-1">
      <Virtuoso<TimelineItem, ListContext>
        className="h-full"
        scrollerRef={(el) => {
          scroller.current?.removeEventListener('scroll', onScroll)
          scroller.current = el instanceof HTMLElement ? el : null
          scroller.current?.addEventListener('scroll', onScroll, { passive: true })
        }}
        data={items}
        context={{ typing, peerName }}
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
            ) : (
              <MessageGroup from={item.from} messages={item.messages} peerName={peerName} queuedNoteAfter={noteAfter} />
            )}
          </Column>
        )}
        components={COMPONENTS}
      />
    </div>
  )
}

interface ListContext {
  typing: boolean
  peerName: string
}

// Stable component identities, so Virtuoso doesn't remount header/footer on every render.
const COMPONENTS = {
  Header: (): ReactNode => <div className="h-2" />,
  Footer: ({ context }: { context?: ListContext }): ReactNode => (
    <Column>
      {context?.typing && <TypingIndicator peerName={context.peerName} />}
      <div className="h-4" />
    </Column>
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
