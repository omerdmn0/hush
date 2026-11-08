import { memo, useRef, useState, type ReactNode } from 'react'
import { Ban, Check, CheckCheck, CircleAlert, Clock, Download, FileText, Image as ImageIcon, LoaderCircle, Mic, Pause, Play, ShieldAlert } from 'lucide-react'
import { formatBytes } from '../../../../shared/files'
import { formatClock } from '@/lib/voice'
import type { ChatMessage, ImageTransfer, MessageStatus } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Avatar } from '@/components/common'
import { formatTime, fullDateTime } from '@/lib/format'
import { thumbSize } from '@/lib/images'
import { useTransfer } from '@/lib/transferStore'
import { linkify } from '@/lib/linkify'
import { cn } from '@/lib/utils'
import { MessageToolbar, ReactionChips, type MessageActions } from './MessageActions'

export interface ImageActions {
  onOpen: (m: ChatMessage) => void
  onRetry: (id: string) => void
  /** Start downloading a big file. */
  onDownload: (id: string) => void
  /** Save a copy of an image or file (asks where). */
  onSave: (m: ChatMessage) => void
}

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
      {m.editedAt && <span title={`Edited ${fullDateTime(m.editedAt)}`}>edited ·</span>}
      <time dateTime={new Date(m.sentAt).toISOString()} title={fullDateTime(m.sentAt)}>
        {formatTime(m.sentAt)}
      </time>
      {showStatus && <StatusIcon status={m.status} />}
    </span>
  )
}

/** Message text with web links that open in the browser. */
function MessageText({ text }: { text: string }): ReactNode {
  return linkify(text).map((s, i) =>
    s.url ? (
      <a
        key={i}
        href={s.url}
        title={s.url}
        onClick={(e) => {
          e.preventDefault()
          window.hush.openLink(s.url!)
        }}
        className="text-cyan underline decoration-cyan/50 underline-offset-2 hover:decoration-cyan"
      >
        {s.text}
      </a>
    ) : (
      s.text
    )
  )
}

/** The message a reply answers, shown at the top of the bubble; click to scroll to it. */
function ReplyQuote({ m, peerName, onJump }: { m: ChatMessage; peerName: string; onJump: (id: string) => void }): ReactNode {
  const q = m.replyTo!
  const who = q.missing ? '' : q.from === 'me' ? 'You' : peerName
  const body = q.missing ? 'Original message isn’t available' : q.deleted ? 'Message deleted' : q.text || (q.hasImage ? 'Photo' : 'Attachment')
  return (
    <button
      type="button"
      disabled={q.missing}
      onClick={() => onJump(q.id)}
      aria-label={q.missing ? body : `Reply to ${who}: ${body}. Show message`}
      className="mb-1.5 flex w-full max-w-[420px] min-w-0 flex-col items-start border-l-2 border-cyan bg-[rgba(4,3,10,.35)] px-2 py-1 text-left enabled:hover:bg-[rgba(4,3,10,.55)]"
    >
      {who && <span className="label text-cyan">{who}</span>}
      <span className={cn('flex w-full min-w-0 items-center gap-1 text-sm text-text-muted', (q.missing || (!q.missing && q.deleted)) && 'italic')}>
        {!q.missing && !q.deleted && q.hasImage && <ImageIcon aria-hidden="true" className="size-3.5 flex-none" />}
        <span className="truncate">{body}</span>
      </span>
    </button>
  )
}

function Bubble({
  m,
  mine,
  isLast,
  images,
  peerName,
  onJump,
  animateFrom
}: {
  m: ChatMessage
  mine: boolean
  isLast: boolean
  images: ImageActions
  peerName: string
  onJump: (id: string) => void
  animateFrom: number
}): ReactNode {
  const t = useTransfer(m.id)
  const rise = m.sentAt >= animateFrom ? 'animate-rise' : undefined
  // Status shown on the last bubble of a group and on anything not yet read (MASTER.md §6).
  const showStatus = mine && (isLast || m.status !== 'read')
  const shape = mine ? 'shape-mine' : 'shape-theirs'
  const quote = m.replyTo && <ReplyQuote m={m} peerName={peerName} onJump={onJump} />

  if (m.deleted) {
    return (
      <div className={cn('cut max-w-full px-3 pt-2 pb-1.5 text-sm text-text-muted italic', shape, '[--fill-c:transparent] opacity-80')}>
        <span className="inline-flex items-center gap-1.5">
          <Ban aria-hidden="true" className="size-3.5" />
          Message deleted
        </span>
        <Meta m={m} showStatus={false} />
      </div>
    )
  }

  if (m.unsupported) {
    return (
      <div className={cn('cut max-w-full px-3 pt-2 pb-1.5 text-sm text-text-muted italic', shape, '[--fill-c:transparent] opacity-80')}>
        <span className="inline-flex items-center gap-1.5">
          <CircleAlert aria-hidden="true" className="size-3.5" />
          Update Hush to see this message
        </span>
        <Meta m={m} showStatus={false} />
      </div>
    )
  }

  if (m.file?.voice) return <VoiceBubble m={m} mine={mine} shape={shape} rise={rise} quote={quote} showStatus={showStatus} transfer={t} onRetry={images.onRetry} />
  if (m.file) return <FileBubble m={m} mine={mine} shape={shape} rise={rise} quote={quote} showStatus={showStatus} images={images} t={t} />

  if (m.image) {
    const size = thumbSize(m.image.width, m.image.height)
    const failed = !mine && !m.image.ready && t?.state === 'failed'
    const receiving = !mine && !m.image.ready && !failed
    const sending = mine && t?.direction === 'up' && t.state === 'active'
    const pct = Math.round((t?.progress ?? 0) * 100)
    return (
      <div className={cn('cut max-w-full p-1', rise, shape)}>
        {quote && <div className="px-1 pt-1">{quote}</div>}
        {/* Size reserved from the stored dimensions, so loading never shifts the list. */}
        <div className="relative max-w-full" style={{ width: size.width, aspectRatio: `${size.width} / ${size.height}` }}>
          <button
            type="button"
            onClick={() => images.onOpen(m)}
            aria-label={`Open image${m.text ? `: ${m.text}` : ''}`}
            className="block h-full w-full cursor-zoom-in focus-visible:outline-offset-[-3px]"
          >
            <img src={m.image.thumbUrl} alt="" className="block h-full w-full bg-pressed object-cover" draggable={false} />
          </button>
          {receiving && (
            <div className="data pointer-events-none absolute inset-0 grid content-center justify-items-center gap-2 bg-[rgba(4,3,10,.6)] text-text">
              <LoaderCircle aria-hidden="true" className="size-5 animate-spin" />
              <span>RECEIVING {pct}%</span>
              <span className="h-1 w-32 overflow-hidden bg-white/20" aria-hidden="true">
                <span className="block h-full bg-cyan shadow-[0_0_8px_var(--cyan)]" style={{ width: `${pct}%` }} />
              </span>
            </div>
          )}
          {failed && (
            <div role="alert" className="data absolute inset-0 grid content-center justify-items-center gap-2 bg-[rgba(4,3,10,.7)] text-text">
              <CircleAlert aria-hidden="true" className="size-5 text-danger-text" />
              <span>COULDN&apos;T DOWNLOAD</span>
              <Button variant="secondary" size="sm" onClick={() => images.onRetry(m.id)}>
                Retry
              </Button>
            </div>
          )}
          {sending && (
            <span className="data pointer-events-none absolute top-1.5 right-1.5 bg-[rgba(4,3,10,.75)] px-1.5 py-0.5 text-text">
              SENDING {pct}%
            </span>
          )}
        </div>
        {m.text && (
          <div className="max-w-[300px] px-2 pt-1.5 text-base leading-6 font-normal [overflow-wrap:anywhere] whitespace-pre-wrap">
            <MessageText text={m.text} />
          </div>
        )}
        <Meta m={m} showStatus={showStatus} block />
      </div>
    )
  }

  return (
    <div className={cn('cut max-w-full px-3 pt-2 pb-1.5 text-base leading-6 font-normal [overflow-wrap:anywhere] whitespace-pre-wrap', rise, shape)}>
      {quote}
      <MessageText text={m.text} />
      <Meta m={m} showStatus={showStatus} />
    </div>
  )
}

export const MessageGroup = memo(function MessageGroup({
  from,
  messages,
  peerName,
  queuedNoteAfter,
  images,
  actions,
  animateFrom
}: {
  from: ChatMessage['from']
  messages: ChatMessage[]
  peerName: string
  /** Id of the message under which "Waiting for … to come online" appears. */
  queuedNoteAfter: string | null
  images: ImageActions
  actions: MessageActions
  /** Messages sent from this moment on fade in. */
  animateFrom: number
}): ReactNode {
  const mine = from === 'me'
  const first = messages[0]
  return (
    <div className={cn('flex gap-2.5 pt-4', mine && 'justify-end')}>
      {!mine && <Avatar name={peerName} who="peer" size={32} />}
      <div className={cn('flex w-[68%] min-w-0 flex-col gap-0.5', mine ? 'items-end' : 'items-start')}>
        {!mine && (
          <div className="mb-1 ml-0.5 flex items-baseline gap-2">
            <span className="label text-cyan">{peerName}</span>
            <span className="data text-text-muted">{formatTime(first.sentAt)}</span>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={m.id} className={cn('flex w-full flex-col', mine ? 'items-end' : 'items-start')}>
            <MessageRow m={m} mine={mine} isLast={i === messages.length - 1} images={images} actions={actions} peerName={peerName} animateFrom={animateFrom} />
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

/** One message with its hover toolbar, right-click menu and reactions. */
const MessageRow = memo(function MessageRow({
  m,
  mine,
  isLast,
  images,
  actions,
  peerName,
  animateFrom
}: {
  m: ChatMessage
  mine: boolean
  isLast: boolean
  images: ImageActions
  actions: MessageActions
  peerName: string
  animateFrom: number
}): ReactNode {
  const [menuOpen, setMenuOpen] = useState(false)
  return (
    <div
      data-message-id={m.id}
      className={cn(
        'group/msg relative flex w-full flex-col transition-shadow duration-300',
        mine ? 'items-end' : 'items-start',
        actions.highlightId === m.id && 'shadow-[0_0_0_2px_var(--cyan),0_0_14px_rgba(0,229,255,.45)]'
      )}
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('a')) return // keep the normal menu for links
        e.preventDefault()
        setMenuOpen(true)
      }}
    >
      <MessageToolbar m={m} mine={mine} actions={actions} menuOpen={menuOpen} onMenuOpenChange={setMenuOpen} />
      <Bubble m={m} mine={mine} isLast={isLast} images={images} peerName={peerName} onJump={actions.onJump} animateFrom={animateFrom} />
      <ReactionChips m={m} mine={mine} actions={actions} peerName={peerName} />
    </div>
  )
})

/** A file: name, size, and Save (it's never opened by Hush). Big ones download on request. */
function FileBubble({
  m,
  mine,
  shape,
  rise,
  quote,
  showStatus,
  images,
  t
}: {
  m: ChatMessage
  mine: boolean
  shape: string
  rise: string | undefined
  quote: ReactNode
  showStatus: boolean
  images: ImageActions
  t: ImageTransfer | undefined
}): ReactNode {
  const f = m.file!
  const pct = Math.round((t?.progress ?? 0) * 100)
  const failed = !mine && !f.ready && t?.state === 'failed'
  const receiving = !mine && !f.ready && !failed && (f.autoDownload || t?.state === 'active')
  const waiting = !mine && !f.ready && !failed && !receiving
  const sending = mine && t?.direction === 'up' && t.state === 'active'
  return (
    <div className={cn('cut max-w-full p-1', rise, shape)}>
      {quote && <div className="px-1 pt-1">{quote}</div>}
      <div className="flex w-[320px] max-w-full items-center gap-3 px-2 py-2">
        <FileText aria-hidden="true" className="size-8 flex-none text-cyan" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold" title={f.name}>
            {f.name}
          </div>
          <div className="data text-text-muted">
            {formatBytes(f.size)}
            {receiving && ` · receiving ${pct}%`}
            {sending && ` · sending ${pct}%`}
            {failed && ' · couldn’t download'}
          </div>
        </div>
        {f.ready ? (
          <Button variant="secondary" size="sm" aria-label={`Save ${f.name}`} onClick={() => images.onSave(m)}>
            <Download />
            Save
          </Button>
        ) : failed ? (
          <Button variant="secondary" size="sm" onClick={() => images.onRetry(m.id)}>
            Retry
          </Button>
        ) : waiting ? (
          <Button variant="secondary" size="sm" aria-label={`Download ${f.name} (${formatBytes(f.size)})`} onClick={() => images.onDownload(m.id)}>
            <Download />
            Download
          </Button>
        ) : receiving ? (
          <LoaderCircle role="img" aria-label="Receiving" className="size-5 animate-spin text-text-muted" />
        ) : null}
      </div>
      {(receiving || sending) && (
        <span className="mx-2 block h-1 overflow-hidden bg-white/15" aria-hidden="true">
          <span className="block h-full bg-cyan shadow-[0_0_8px_var(--cyan)]" style={{ width: `${pct}%` }} />
        </span>
      )}
      {f.risky && (
        <div className="mx-2 mt-1 flex items-center gap-1.5 text-xs text-queued">
          <ShieldAlert aria-hidden="true" className="size-3.5 flex-none" />
          A program — only run it if you expected it
        </div>
      )}
      {m.text && (
        <div className="max-w-[320px] px-2 pt-1.5 text-base leading-6 font-normal [overflow-wrap:anywhere] whitespace-pre-wrap">
          <MessageText text={m.text} />
        </div>
      )}
      <Meta m={m} showStatus={showStatus} block />
    </div>
  )
}

/** A voice note: play / pause, a waveform that fills as it plays (click to jump), and its length. */
function VoiceBubble({
  m,
  mine,
  shape,
  rise,
  quote,
  showStatus,
  transfer,
  onRetry
}: {
  m: ChatMessage
  mine: boolean
  shape: string
  rise: string | undefined
  quote: ReactNode
  showStatus: boolean
  transfer: ImageTransfer | undefined
  onRetry: (id: string) => void
}): ReactNode {
  const v = m.file!.voice!
  const ready = m.file!.ready
  const audio = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [at, setAt] = useState(0)
  const failed = !mine && !ready && transfer?.state === 'failed'
  const bars = v.peaks.length > 0 ? v.peaks : Array.from({ length: 48 }, () => 60)
  const shown = at / v.durationMs
  const toggle = (): void => {
    const el = audio.current
    if (!el) return
    if (el.paused) void el.play()
    else el.pause()
  }
  return (
    <div className={cn('cut max-w-full p-1', rise, shape)}>
      {quote && <div className="px-1 pt-1">{quote}</div>}
      <div className="flex w-[300px] max-w-full items-center gap-2.5 px-2 py-1.5">
        {failed ? (
          <Button variant="secondary" size="sm" onClick={() => onRetry(m.id)}>
            Retry
          </Button>
        ) : (
          <Button
            size="icon"
            className="size-9 flex-none"
            disabled={!ready}
            aria-label={!ready ? 'Voice note arriving' : playing ? 'Pause voice note' : `Play voice note, ${formatClock(v.durationMs)}`}
            onClick={toggle}
          >
            {!ready ? <LoaderCircle className="animate-spin" /> : playing ? <Pause className="fill-current" /> : <Play className="fill-current" />}
          </Button>
        )}
        <div
          aria-hidden="true"
          className={cn('flex h-8 min-w-0 flex-1 items-center gap-[2px]', ready && 'cursor-pointer')}
          onClick={(e) => {
            const el = audio.current
            if (!el || !ready) return
            const r = e.currentTarget.getBoundingClientRect()
            el.currentTime = (((e.clientX - r.left) / r.width) * v.durationMs) / 1000
            setAt(el.currentTime * 1000)
          }}
        >
          {bars.map((p, i) => (
            <span
              key={i}
              className={cn('w-full min-w-px', i / bars.length < shown ? 'bg-cyan' : 'bg-text-muted/45')}
              style={{ height: `${Math.max(12, (p / 255) * 100)}%` }}
            />
          ))}
        </div>
        <span className="data flex-none text-text-muted">
          <Mic aria-hidden="true" className="mr-0.5 inline size-3" />
          {formatClock(playing || at > 0 ? at : v.durationMs)}
        </span>
        <audio
          ref={audio}
          src={ready ? v.url : undefined}
          preload="none"
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => (setPlaying(false), setAt(0))}
          onTimeUpdate={(e) => setAt(Math.min(v.durationMs, e.currentTarget.currentTime * 1000))}
        />
      </div>
      <Meta m={m} showStatus={showStatus} block />
    </div>
  )
}
