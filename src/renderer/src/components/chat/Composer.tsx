import { useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { ImagePlus, SendHorizontal, Smile } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

const MAX_HEIGHT = 200 // ≈ 8 lines

export function Composer({
  peerName,
  disabled,
  onSend,
  inputRef
}: {
  peerName: string
  disabled: boolean
  onSend: (text: string) => void
  inputRef?: Ref<HTMLTextAreaElement>
}): ReactNode {
  const [text, setText] = useState('')
  const ta = useRef<HTMLTextAreaElement | null>(null)

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  const send = (): void => {
    const value = text.trim()
    if (!value || disabled) return
    onSend(value)
    setText('')
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
          <NotYet label="Attach image">
            <ImagePlus className="size-5" />
          </NotYet>
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
            disabled={disabled}
            placeholder={disabled ? `Link someone in settings to start chatting` : `Message ${peerName}`}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                send()
              }
            }}
            className="max-h-[200px] min-h-[42px] flex-1 resize-none border-0 bg-transparent px-1.5 py-[9px] font-sans text-base leading-6 font-normal text-text caret-cyan outline-none placeholder:text-text-muted focus-visible:outline-none disabled:cursor-not-allowed"
          />
          <NotYet label="Emoji">
            <Smile className="size-5" />
          </NotYet>
          <Button size="icon-lg" aria-label="Send message" disabled={disabled || !text.trim()} onClick={send}>
            <SendHorizontal />
          </Button>
        </div>
        <div className="data mx-1 mt-1.5 text-text-muted">
          <kbd className="font-[inherit] text-text">ENTER</kbd> send · <kbd className="font-[inherit] text-text">SHIFT+ENTER</kbd> new line · drop or
          paste images
        </div>
      </div>
    </div>
  )
}

/** Icon button for a feature that isn't built yet: focusable, explained by its tooltip. */
function NotYet({ label, children }: { label: string; children: ReactNode }): ReactNode {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="icon" size="icon-lg" aria-label={`${label} (not available yet)`} aria-disabled>
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label} — not available yet</TooltipContent>
    </Tooltip>
  )
}
