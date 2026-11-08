import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Image as ImageIcon, LoaderCircle, Search, X } from 'lucide-react'
import type { ChannelInfo, SearchResult } from '../../../../shared/types'
import { queryTerms, snippet } from '../../../../shared/search'
import { Button } from '@/components/ui/button'
import { dayLabel, formatTime } from '@/lib/format'

/** Searching runs this long after the last keystroke. */
const DEBOUNCE_MS = 150

/**
 * Message search, beside the chat. It runs in memory in the main process (history is encrypted
 * on disk, so there is no index there). Picking a result scrolls the chat to it.
 */
export function SearchPanel({
  peerName,
  channels,
  onPick,
  onClose
}: {
  peerName: string
  channels: ChannelInfo[]
  onPick: (r: SearchResult) => void
  onClose: () => void
}): ReactNode {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<{ query: string; results: SearchResult[]; more: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => input.current?.focus(), [])

  useEffect(() => {
    if (queryTerms(query).length === 0) {
      setFound(null)
      return
    }
    let current = true
    const t = setTimeout(() => {
      setBusy(true)
      void window.hush
        .search(query)
        .then((r) => current && setFound({ query, ...r }))
        .finally(() => current && setBusy(false))
    }, DEBOUNCE_MS)
    return () => {
      current = false
      clearTimeout(t)
    }
  }, [query])

  const rows = useMemo(() => {
    const terms = found ? queryTerms(found.query) : []
    return found?.results.map((r) => ({ r, s: snippet(r.text, terms) }))
  }, [found])
  const status = !found
    ? 'Type to search your messages'
    : found.results.length === 0
      ? 'No messages found'
      : found.more
        ? `Newest ${found.results.length} matches`
        : `${found.results.length} match${found.results.length === 1 ? '' : 'es'}`
  const now = Date.now()

  return (
    <aside
      aria-label="Search messages"
      className="cut panel absolute top-[72px] right-4 z-30 flex max-h-[calc(100%-200px)] w-[min(380px,calc(100%-2rem))] flex-col [--fill-c:var(--surface-elevated)]"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          onClose()
        }
      }}
    >
      <div className="flex items-center gap-2 border-b border-edge p-3">
        <Search aria-hidden="true" className="size-4 flex-none text-cyan" />
        <input
          ref={input}
          type="search"
          aria-label="Search messages"
          aria-describedby="search-status"
          placeholder="Search messages"
          value={query}
          maxLength={200}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && found?.results[0]) onPick(found.results[0])
          }}
          className="min-w-0 flex-1 border-0 bg-transparent font-sans text-base text-text caret-cyan outline-none placeholder:text-text-muted [&::-webkit-search-cancel-button]:hidden"
        />
        {busy && <LoaderCircle aria-hidden="true" className="size-4 animate-spin text-text-muted" />}
        <Button variant="icon" size="icon" className="size-8" aria-label="Close search" onClick={onClose}>
          <X className="size-4" />
        </Button>
      </div>
      <div id="search-status" role="status" className="label px-4 pt-2.5 pb-1.5">
        {status}
      </div>
      <ul className="m-0 min-h-0 flex-1 list-none overflow-y-auto p-2 pt-0">
        {rows?.map(({ r, s }) => {
          return (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => onPick(r)}
                className="flex w-full flex-col gap-1 rounded-sm px-2.5 py-2 text-left hover:bg-hover focus-visible:bg-hover"
              >
                <span className="flex items-baseline gap-2">
                  <span className={r.from === 'me' ? 'label text-magenta' : 'label text-cyan'}>{r.from === 'me' ? 'You' : peerName}</span>
                  <span className="data text-text-muted">
                    {dayLabel(r.sentAt, now)} · {formatTime(r.sentAt)}
                  </span>
                  {r.hasImage && <ImageIcon role="img" aria-label="with a picture" className="size-3.5 text-text-muted" />}
                  <span className="ml-auto max-w-[120px] flex-none truncate text-xs text-text-muted">#{channels.find((c) => c.id === (r.channel ?? ''))?.name}</span>
                </span>
                <span className="line-clamp-3 text-sm leading-5 [overflow-wrap:anywhere] text-text">
                  {s.cutStart && '…'}
                  {s.parts.map((p, i) =>
                    p.hit ? (
                      <mark key={i} className="bg-cyan-subtle px-px text-cyan">
                        {p.text}
                      </mark>
                    ) : (
                      p.text
                    )
                  )}
                  {s.cutEnd && '…'}
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </aside>
  )
}
