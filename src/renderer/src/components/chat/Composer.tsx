import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { CircleAlert, ImagePlus, LoaderCircle, SendHorizontal, Smile, X } from 'lucide-react'
import { IMAGE_MIME, MAX_TEXT_LENGTH } from '../../../../shared/protocol'
import type { OutgoingImage } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ImageError, imageErrorText, prepareImage, type PreparedImage } from '@/lib/images'
import { cn } from '@/lib/utils'
import { EmojiPanel } from './EmojiPanel'

const MAX_HEIGHT = 200 // ≈ 8 lines
/** Re-send "typing" at most this often while the user keeps typing. */
const TYPING_REFRESH_MS = 3000
/** Stop "typing" after this long without keystrokes. */
const TYPING_IDLE_MS = 4000
const MAX_ATTACHMENTS = 10

export interface ComposerHandle {
  /** Adds dropped/pasted/picked files to the tray (validated first). */
  addFiles: (files: File[]) => void
}

export function Composer({
  peerName,
  disabled,
  onSend,
  onSendImage,
  onTyping,
  inputRef,
  handleRef
}: {
  peerName: string
  disabled: boolean
  onSend: (text: string) => Promise<void>
  onSendImage: (image: OutgoingImage, caption: string) => Promise<void>
  onTyping: (on: boolean) => void
  inputRef?: Ref<HTMLTextAreaElement>
  handleRef?: Ref<ComposerHandle>
}): ReactNode {
  const [text, setText] = useState('')
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [attachments, setAttachments] = useState<PreparedImage[]>([])
  const [preparing, setPreparing] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const typing = useRef({ on: false, lastSent: 0, idle: undefined as ReturnType<typeof setTimeout> | undefined })

  useLayoutEffect(() => {
    const el = ta.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT)}px`
  }, [text])

  // Free preview object URLs when the composer goes away.
  const live = useRef(attachments)
  live.current = attachments
  useEffect(() => () => live.current.forEach((a) => URL.revokeObjectURL(a.previewUrl)), [])

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

  const addFiles = (files: File[]): void => {
    if (disabled || files.length === 0) return
    setError(null)
    const room = MAX_ATTACHMENTS - live.current.length - preparing
    if (files.length > room) setError(`You can attach up to ${MAX_ATTACHMENTS} images at a time.`)
    for (const file of files.slice(0, Math.max(0, room))) {
      setPreparing((n) => n + 1)
      prepareImage(file)
        .then((img) => setAttachments((prev) => [...prev, img]))
        .catch((e: unknown) => setError(e instanceof ImageError ? imageErrorText(e) : `“${file.name}” couldn't be added.`))
        .finally(() => setPreparing((n) => n - 1))
    }
    ta.current?.focus()
  }
  useImperativeHandle(handleRef, () => ({ addFiles }))

  const remove = (key: string): void => {
    setAttachments((prev) => {
      const gone = prev.find((a) => a.key === key)
      if (gone) URL.revokeObjectURL(gone.previewUrl)
      return prev.filter((a) => a.key !== key)
    })
    ta.current?.focus()
  }

  const canSend = !disabled && !sending && preparing === 0 && (text.trim() !== '' || attachments.length > 0)

  const send = async (): Promise<void> => {
    if (!canSend) return
    const value = text.trim()
    const queue = attachments
    stopTyping()
    setError(null)
    setText('')
    if (queue.length === 0) {
      void onSend(value).catch(() => setText(value)) // keep the text if sending failed
      return
    }
    setSending(true)
    try {
      // Each image is its own message; the text becomes the caption of the last one.
      for (let i = 0; i < queue.length; i++) {
        await onSendImage(queue[i].outgoing, i === queue.length - 1 ? value : '')
        URL.revokeObjectURL(queue[i].previewUrl)
        setAttachments((prev) => prev.filter((a) => a.key !== queue[i].key))
      }
    } catch {
      setText(value)
      setError("Some images couldn't be sent. They're still in the tray — try again.")
    } finally {
      setSending(false)
    }
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

  const trayVisible = attachments.length > 0 || preparing > 0

  return (
    <div className="flex-none pb-3.5">
      <div className="mx-auto max-w-[760px] px-6">
        {trayVisible && (
          <ul aria-label="Images to send" className="m-0 mb-2 flex list-none flex-wrap gap-2 p-0">
            {attachments.map((a) => (
              <li key={a.key} className="relative">
                <img
                  src={a.previewUrl}
                  alt={a.name}
                  title={a.name}
                  className="chamfer-avatar block size-16 bg-pressed object-cover [--s:64px]"
                  draggable={false}
                />
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={`Remove ${a.name}`}
                  disabled={sending}
                  onClick={() => remove(a.key)}
                  className="absolute -top-2 -right-2 size-6 bg-surface-elevated"
                >
                  <X className="size-3.5" />
                </Button>
              </li>
            ))}
            {Array.from({ length: preparing }, (_, i) => (
              <li key={`p${i}`} aria-label="Preparing image" className="grid size-16 place-items-center bg-pressed">
                <LoaderCircle aria-hidden="true" className="size-5 animate-spin text-text-muted" />
              </li>
            ))}
          </ul>
        )}
        <div
          className={cn(
            'cut panel panel-sm flex min-h-14 items-end gap-1 p-[7px] [--edge-c:var(--border-strong)]',
            'focus-within:drop-shadow-[0_0_6px_rgba(0,229,255,.25)] focus-within:[--edge-c:var(--cyan)] focus-within:before:inset-0.5',
            disabled && 'opacity-60'
          )}
        >
          <input
            ref={filePicker}
            type="file"
            accept={IMAGE_MIME.join(',')}
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])])
              e.target.value = '' // allow picking the same file again
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="icon" size="icon-lg" aria-label="Attach images" disabled={disabled || sending} onClick={() => filePicker.current?.click()}>
                <ImagePlus className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach images (or drop / paste them)</TooltipContent>
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
            aria-describedby={error ? 'composer-error' : undefined}
            placeholder={
              disabled ? 'Link someone in settings to start chatting' : attachments.length ? 'Add a caption (optional)' : `Message ${peerName}`
            }
            onChange={(e) => update(e.target.value)}
            onBlur={stopTyping}
            onPaste={(e) => {
              const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
              if (files.length) {
                e.preventDefault()
                addFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                void send()
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
          <Button size="icon-lg" aria-label={sending ? 'Sending…' : 'Send message'} disabled={!canSend} onClick={() => void send()}>
            {sending ? <LoaderCircle className="animate-spin" /> : <SendHorizontal />}
          </Button>
        </div>
        {error ? (
          <div id="composer-error" role="alert" className="mx-1 mt-1.5 flex items-start gap-1.5 text-xs text-danger-text">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
            {error}
          </div>
        ) : (
          <div className="data mx-1 mt-1.5 text-text-muted">
            <kbd className="font-[inherit] text-text">ENTER</kbd> send · <kbd className="font-[inherit] text-text">SHIFT+ENTER</kbd> new line · drop or
            paste images
          </div>
        )}
      </div>
    </div>
  )
}
