import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ImagePlus, SendHorizontal, Smile } from 'lucide-react'
import { MAX_TEXT_LENGTH } from '../../../../shared/protocol'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { EmojiPanel } from './EmojiPanel'

const MAX_HEIGHT = 200 // ≈ 8 lines
/** Re-send "typing" at most this often while the user keeps typing. */
const TYPING_REFRESH_MS = 3000
/** Stop "typing" after this long without keystrokes. */
const TYPING_IDLE_MS = 4000

export function Composer({
  peerName,
  disabled,
  onSend,
  onTyping,
  inputRef
}: {
  peerName: string
  disabled: boolean
  onSend: (text: string) => Promise<void>
  onTyping: (on: boolean) => void
  inputRef?: Ref<HTMLTextAreaElement>
}): ReactNode {
  const [text, setText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const ta = useRef<HTMLTextAreaElement | null>(null)
  const typing = useRef({ on: false, lastSent: 0, idle: undefined as ReturnType<typeof setTimeout> | undefined })

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const stopTyping = (): void => {
    const t = typing.current
    clearTimeout(t.idle)
    if (t.on) {
      t.on = false
      onTyping(false)
    }
  }
  useEffect(() => () => clearTimeout(typing.current.idle), [])

  const noteTyping = (value: string): void => {
    const t = typing.current
    if (!value.trim()) return stopTyping()
    const now = Date.now()
    if (!t.on || now - t.lastSent > TYPING_REFRESH_MS) {
      t.on = true
      t.lastSent = now
      onTyping(true)
    }
    clearTimeout(t.idle)
    t.idle = setTimeout(stopTyping, TYPING_IDLE_MS)
  }

  const update = (value: string): void => {
    setText(value)
    noteTyping(value)
  }

  const send = (): void => {
    const value = text.trim()
    if (!value || disabled) return
    stopTyping()
    setText('')
    void onSend(value).catch(() => setText(value)) // keep the text if sending failed
  }

  const insertEmoji = (emoji: string): void => {
    const el = ta.current
    const start = el?.selectionStart ?? text.length
    const end = el?.selectionEnd ?? text.length
    const next = (text.slice(0, start) + emoji + text.slice(end)).slice(0, MAX_TEXT_LENGTH)
    update(next)
    setEmojiOpen(false)
    requestAnimationFrame(() => {
      el?.focus()
      el?.setSelectionRange(start + emoji.length, start + emoji.length)
    })
  }

  const setRefs = (el: HTMLTextAreaElement | null): void => {
    ta.current = el
    if (typeof inputRef === 'function') inputRef(el)
    else if (inputRef) inputRef.current = el
  }

  return (
    <div className="flex-none pb-3.5">
      <div className="mx-auto max-w-[760px] px-6">
        <div
          className={cn(
            'cut panel panel-sm flex min-h-14 items-end gap-1 p-[7px] [--edge-c:var(--border-strong)]',
            'focus-within:drop-shadow-[0_0_6px_rgba(0,229,255,.25)] focus-within:[--edge-c:var(--cyan)] focus-within:before:inset-0.5',
            disabled && 'opacity-60'
          )}
        >
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="icon" size="icon-lg" aria-label="Attach image (not available yet)" aria-disabled>
                <ImagePlus className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach image — not available yet</TooltipContent>
          </Tooltip>
          <span aria-hidden="true" className="py-[9px] pl-1.5 font-mono text-base leading-6 font-bold text-magenta">
            &gt;
          </span>
          <label htmlFor="composer" className="sr-only">
            Message {peerName}
          </label>
          <textarea
            id="composer"
            ref={setRefs}
            rows={1}
            value={text}
            maxLength={MAX_TEXT_LENGTH}
            disabled={disabled}
            placeholder={disabled ? 'Link someone in settings to start chatting' : `Message ${peerName}`}
            onChange={(e) => update(e.target.value)}
            onBlur={stopTyping}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            className="max-h-[200px] min-h-[42px] flex-1 resize-none border-0 bg-transparent px-1.5 py-[9px] font-sans text-base leading-6 font-normal text-text caret-cyan outline-none placeholder:text-text-muted focus-visible:outline-none disabled:cursor-not-allowed"
          />
          <Popover open={emojiOpen} onOpenChange={setEmojiOpen}>
            <PopoverTrigger asChild>
              <Button variant="icon" size="icon-lg" aria-label="Emoji" disabled={disabled}>
                <Smile className="size-5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              className="w-auto overflow-hidden p-0"
              // Focus returns to the message box after picking, handled in insertEmoji.
              onCloseAutoFocus={(e) => e.preventDefault()}
            >
              <EmojiPanel onPick={insertEmoji} />
            </PopoverContent>
          </Popover>
          <Button size="icon-lg" aria-label="Send message" disabled={disabled || !text.trim()} onClick={send}>
            <SendHorizontal />
          </Button>
        </div>
        <div className="data mx-1 mt-1.5 text-text-muted">
          <kbd className="font-[inherit] text-text">ENTER</kbd> send · <kbd className="font-[inherit] text-text">SHIFT+ENTER</kbd> new line
        </div>
      </div>
    </div>
  )
}
