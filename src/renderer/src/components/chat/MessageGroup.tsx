import { memo, type ReactNode } from 'react'
import { Check, CheckCheck, Clock } from 'lucide-react'
import type { ChatMessage, MessageStatus } from '../../../../shared/types'
import { Avatar } from '@/components/common'
import { formatTime, fullDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'

const THUMB_MAX_W = 300
const THUMB_MAX_H = 320

function StatusIcon({ status }: { status: MessageStatus }): ReactNode {
  const cls = 'size-3.5'
  switch (status) {
    case 'queued':
      return <Clock role="img" aria-label="Queued" className={cn(cls, 'text-queued')} />
    case 'sent':
      return <Check role="img" aria-label="Sent" className={cls} />
    case 'delivered':
      return <CheckCheck role="img" aria-label="Delivered" className={cls} />
    case 'read':
      return <CheckCheck role="img" aria-label="Read" className={cn(cls, 'text-cyan')} />
  }
}

function Meta({ m, showStatus, block }: { m: ChatMessage; showStatus: boolean; block?: boolean }): ReactNode {
  return (
    <span
      className={cn(
        'data inline-flex items-center gap-1 text-text-muted',
        block ? 'mx-1.5 mt-1 mb-0.5 flex justify-end' : 'float-right mt-1.5 -mb-0.5 ml-3'
      )}
    >
      <time dateTime={new Date(m.sentAt).toISOString()} title={fullDateTime(m.sentAt)}>
        {formatTime(m.sentAt)}
      </time>
      {showStatus && <StatusIcon status={m.status} />}
    </span>
  )
}

function Bubble({ m, mine, isLast }: { m: ChatMessage; mine: boolean; isLast: boolean }): ReactNode {
  // Status shown on the last bubble of a group and on anything not yet read (MASTER.md §6).
  const showStatus = mine && (isLast || m.status !== 'read')
  const shape = mine ? 'shape-mine' : 'shape-theirs'

  if (m.image) {
    const scale = Math.min(1, THUMB_MAX_W / m.image.width, THUMB_MAX_H / m.image.height)
    return (
      <div className={cn('cut animate-rise max-w-full p-1', shape)}>
        {/* Size reserved up front so loading never shifts the list. Click-to-enlarge arrives in stage d. */}
        <img
          src={m.image.src}
          alt={m.image.alt ?? ''}
          width={Math.round(m.image.width * scale)}
          height={Math.round(m.image.height * scale)}
          className="block max-w-full bg-pressed object-cover"
          draggable={false}
        />
        {m.text && <div className="px-2 pt-1.5 text-base leading-6 font-normal">{m.text}</div>}
        <Meta m={m} showStatus={showStatus} block />
      </div>
    )
  }

  return (
    <div className={cn('cut animate-rise max-w-full px-3 pt-2 pb-1.5 text-base leading-6 font-normal [overflow-wrap:anywhere] whitespace-pre-wrap', shape)}>
      {m.text}
      <Meta m={m} showStatus={showStatus} />
    </div>
  )
}

export const MessageGroup = memo(function MessageGroup({
  from,
  messages,
  peerName,
  queuedNoteAfter
}: {
  from: ChatMessage['from']
  messages: ChatMessage[]
  peerName: string
  /** Id of the message under which "Waiting for … to come online" appears. */
  queuedNoteAfter: string | null
}): ReactNode {
  const mine = from === 'me'
  const first = messages[0]
  return (
    <div className={cn('flex gap-2.5 pt-4', mine && 'justify-end')}>
      {!mine && <Avatar name={peerName} who="peer" size={32} />}
      <div className={cn('flex max-w-[68%] min-w-0 flex-col gap-0.5', mine ? 'items-end' : 'items-start')}>
        {!mine && (
          <div className="mb-1 ml-0.5 flex items-baseline gap-2">
            <span className="label text-cyan">{peerName}</span>
            <span className="data text-text-muted">{formatTime(first.sentAt)}</span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id} className={cn('flex max-w-full flex-col', mine ? 'items-end' : 'items-start')}>
            <Bubble m={m} mine={mine} isLast={i === messages.length - 1} />
            {m.id === queuedNoteAfter && (
              <div className="data mt-1.5 flex items-center gap-1.5 text-queued">
                <Clock aria-hidden="true" className="size-3.5" />
                <b className="font-bold">QUEUED</b> · Waiting for {peerName} to come online
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
})
