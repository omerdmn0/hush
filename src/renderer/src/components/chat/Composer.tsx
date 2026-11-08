import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from 'react'
import { Check, CircleAlert, FileText, LoaderCircle, Mic, Paperclip, Pencil, Reply, SendHorizontal, Smile, Square, Trash2, X } from 'lucide-react'
import { IMAGE_MIME, MAX_FILE_BYTES, MAX_IMAGE_BYTES, MAX_TEXT_LENGTH, MAX_VOICE_MS } from '../../../../shared/protocol'
import { formatBytes } from '../../../../shared/files'
import type { ChatMessage, OutgoingImage } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { prepareImage, toOutgoing, type PreparedImage } from '@/lib/images'
import { formatClock, recordVoice, type VoiceNote, type VoiceRecording } from '@/lib/voice'
import { cn } from '@/lib/utils'
import { EmojiPanel } from './EmojiPanel'

const MAX_HEIGHT = 200 // ≈ 8 lines
/** Re-send "typing" at most this often while the user keeps typing. */
const TYPING_REFRESH_MS = 3000
/** Stop "typing" after this long without keystrokes. */
const TYPING_IDLE_MS = 4000
const MAX_ATTACHMENTS = 10
/** What was being written, kept while the composer is away (the Settings screen replaces it). */
let draft = ''

/** Writing a reply to a message, or editing one of your own. */
export interface ComposerMode {
  kind: 'reply' | 'edit'
  message: ChatMessage
}

export interface ComposerHandle {
  /** Adds dropped/pasted/picked files to the tray (validated first). */
  addFiles: (files: File[]) => void
}

export function Composer({
  peerName,
  disabled,
  disabledHint = 'Link someone in settings to start chatting',
  onSend,
  onSendImage,
  onTyping,
  inputRef,
  handleRef,
  mode,
  onCancelMode,
  onEdit,
  onEditLast,
  onSendFile,
  onSendVoice,
  micId
}: {
  peerName: string
  disabled: boolean
  disabledHint?: string
  onSend: (text: string, replyTo?: string) => Promise<void>
  onSendImage: (image: OutgoingImage, caption: string, replyTo?: string) => Promise<void>
  mode: ComposerMode | null
  onCancelMode: () => void
  onEdit: (id: string, text: string) => Promise<void>
  /** ↑ in an empty message box: edit your last message. */
  onEditLast: () => void
  onSendFile: (file: File, caption: string, replyTo?: string) => Promise<void>
  onSendVoice: (note: VoiceNote, replyTo?: string) => Promise<void>
  /** Microphone for voice notes (Settings → Audio). */
  micId: string
  onTyping: (on: boolean) => void
  inputRef?: Ref<HTMLTextAreaElement>
  handleRef?: Ref<ComposerHandle>
}): ReactNode {
  const [text, setText] = useState(draft)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [attachments, setAttachments] = useState<PreparedImage[]>([])
  /** Non-image files (and images too big or odd to preview), sent as files. */
  const [files, setFiles] = useState<{ key: string; file: File }[]>([])
  const [recording, setRecording] = useState<VoiceRecording | null>(null)
  const [recordedMs, setRecordedMs] = useState(0)
  const [preparing, setPreparing] = useState(0)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const ta = useRef<HTMLTextAreaElement | null>(null)
  const filePicker = useRef<HTMLInputElement>(null)
  const typing = useRef({ on: false, lastSent: 0, idle: undefined as ReturnType<typeof setTimeout> | undefined })
  const editing = mode?.kind === 'edit' ? mode.message : null
  useEffect(() => {
    if (!editing) draft = text
  }, [text, editing])

  // Entering edit mode puts the message's text in the box; reply mode just focuses it.
  const modeKey = mode ? `${mode.kind}:${mode.message.id}` : ''
  useEffect(() => {
    if (!mode) return
    if (mode.kind === 'edit') setText(mode.message.text)
    requestAnimationFrame(() => {
      const el = ta.current
      el?.focus()
      if (el) el.setSelectionRange(el.value.length, el.value.length)
    })
    // Runs only when the mode itself changes (not on every render of the same mode).
  }, [modeKey])

  const cancelMode = (): void => {
    if (editing) setText('')
    onCancelMode()
  }

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

  const liveFiles = useRef(files)
  liveFiles.current = files
  const addFile = (file: File): void => setFiles((prev) => [...prev, { key: `${Date.now()}-${Math.random()}`, file }])
  const addFiles = (picked: File[]): void => {
    if (disabled || editing || picked.length === 0) return
    setError(null)
    const room = MAX_ATTACHMENTS - live.current.length - liveFiles.current.length - preparing
    if (picked.length > room) setError(`You can attach up to ${MAX_ATTACHMENTS} files at a time.`)
    for (const file of picked.slice(0, Math.max(0, room))) {
      if (file.size === 0) {
        setError(`“${file.name}” is empty.`)
      } else if (file.size > MAX_FILE_BYTES) {
        setError(`“${file.name}” is ${formatBytes(file.size)} — files can be up to 1 GB.`)
      } else if ((IMAGE_MIME as readonly string[]).includes(file.type) && file.size <= MAX_IMAGE_BYTES) {
        // Pictures get a preview in the chat; one that can't be previewed goes as a plain file.
        setPreparing((n) => n + 1)
        prepareImage(file)
          .then((img) => setAttachments((prev) => [...prev, img]))
          .catch(() => addFile(file))
          .finally(() => setPreparing((n) => n - 1))
      } else {
        addFile(file)
      }
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

  const canSend = editing
    ? !disabled && !sending && (text.trim() !== '' || !!editing.image || !!editing.file)
    : !disabled && !sending && preparing === 0 && (text.trim() !== '' || attachments.length > 0 || files.length > 0)

  const send = async (): Promise<void> => {
    if (!canSend) return
    const value = text.trim()
    const queue = attachments
    const replyTo = mode?.kind === 'reply' ? mode.message.id : undefined
    stopTyping()
    setError(null)
    if (editing) {
      setSending(true)
      try {
        await onEdit(editing.id, value)
        setText('')
        onCancelMode()
      } catch {
        setError("The edit couldn't be saved.")
      } finally {
        setSending(false)
      }
      return
    }
    setText('')
    if (replyTo) onCancelMode()
    const fileQueue = files
    if (queue.length === 0 && fileQueue.length === 0) {
      void onSend(value, replyTo).catch(() => setText(value)) // keep the text if sending failed
      return
    }
    setSending(true)
    const total = queue.length + fileQueue.length
    let n = 0
    try {
      // Each attachment is its own message; the text becomes the caption of the last one,
      // and a reply is attached to the first.
      for (const img of queue) {
        await onSendImage(await toOutgoing(img), ++n === total ? value : '', n === 1 ? replyTo : undefined)
        URL.revokeObjectURL(img.previewUrl)
        setAttachments((prev) => prev.filter((a) => a.key !== img.key))
      }
      for (const f of fileQueue) {
        await onSendFile(f.file, ++n === total ? value : '', n === 1 ? replyTo : undefined)
        setFiles((prev) => prev.filter((x) => x.key !== f.key))
      }
    } catch (e) {
      setText(value)
      const why = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
      setError(`Some attachments couldn't be sent (${why}). They're still in the tray — try again.`)
    } finally {
      setSending(false)
    }
  }

  // ----- voice notes -----
  useEffect(() => {
    if (!recording) return
    const t = setInterval(() => setRecordedMs(performance.now() - recording.startedAt), 250)
    return () => clearInterval(t)
  }, [recording])
  const recordingRef = useRef(recording)
  recordingRef.current = recording
  const gone = useRef(false)
  useEffect(() => {
    gone.current = false
    return () => {
      gone.current = true
      recordingRef.current?.cancel()
    }
  }, [])

  const startingToRecord = useRef(false)
  const startRecording = async (): Promise<void> => {
    if (startingToRecord.current) return // a second click would leave a microphone open
    startingToRecord.current = true
    setError(null)
    try {
      setRecordedMs(0)
      // At 5 minutes it stops and sends by itself.
      const rec = await recordVoice(micId, () => void finishRecording(true))
      if (gone.current) rec.cancel()
      else setRecording(rec)
    } catch {
      setError("Can't use your microphone. Check it's plugged in and allowed, then pick it in Settings → Audio.")
    } finally {
      startingToRecord.current = false
    }
  }
  const finishRecording = async (send: boolean): Promise<void> => {
    const rec = recordingRef.current
    if (!rec) return
    setRecording(null)
    if (!send) return rec.cancel()
    const note = await rec.stop()
    if (!note) return
    const replyTo = mode?.kind === 'reply' ? mode.message.id : undefined
    if (replyTo) onCancelMode()
    setSending(true)
    try {
      await onSendVoice(note, replyTo)
    } catch {
      setError("The voice note couldn't be sent.")
    } finally {
      setSending(false)
      ta.current?.focus()
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

  const trayVisible = attachments.length > 0 || files.length > 0 || preparing > 0
  const canRecord = !disabled && !editing && !sending && text.trim() === '' && attachments.length === 0 && files.length === 0

  return (
    <div className="flex-none pb-3.5">
      <div className="mx-auto max-w-[760px] px-6">
        {mode && (
          <div className="mb-1.5 flex items-center gap-2 border-l-2 border-cyan bg-surface py-1 pr-1 pl-3 text-sm">
            {editing ? <Pencil aria-hidden="true" className="size-4 flex-none text-cyan" /> : <Reply aria-hidden="true" className="size-4 flex-none text-cyan" />}
            <span className="min-w-0 flex-1 truncate">
              {editing ? (
                'Editing message'
              ) : (
                <>
                  Replying to <b className="font-semibold">{mode.message.from === 'me' ? 'yourself' : peerName}</b>
                  <span className="text-text-muted">: {mode.message.text || (mode.message.image ? 'Photo' : mode.message.file?.voice ? 'Voice note' : (mode.message.file?.name ?? ''))}</span>
                </>
              )}
            </span>
            <span className="data text-text-muted" aria-hidden="true">
              ESC
            </span>
            <Button variant="icon" size="icon" className="size-7" aria-label={editing ? 'Cancel editing' : 'Cancel reply'} onClick={cancelMode}>
              <X className="size-4" />
            </Button>
          </div>
        )}
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
            {files.map((f) => (
              <li key={f.key} className="relative flex h-16 max-w-[220px] items-center gap-2 bg-pressed py-2 pr-4 pl-3">
                <FileText aria-hidden="true" className="size-6 flex-none text-cyan" />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate text-sm" title={f.file.name}>
                    {f.file.name || 'Pasted file'}
                  </span>
                  <span className="data text-text-muted">{formatBytes(f.file.size)}</span>
                </span>
                <Button
                  variant="secondary"
                  size="icon"
                  aria-label={`Remove ${f.file.name}`}
                  disabled={sending}
                  onClick={() => setFiles((prev) => prev.filter((x) => x.key !== f.key))}
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
            multiple
            hidden
            onChange={(e) => {
              addFiles([...(e.target.files ?? [])])
              e.target.value = '' // allow picking the same file again
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="icon" size="icon-lg" aria-label="Attach files" disabled={disabled || sending || !!editing || !!recording} onClick={() => filePicker.current?.click()}>
                <Paperclip className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Attach pictures or files (or drop / paste them)</TooltipContent>
          </Tooltip>
          <span aria-hidden="true" className="py-[9px] pl-1.5 font-mono text-base leading-6 font-bold text-magenta">
            &gt;
          </span>
          {recording ? (
            <div
              role="group"
              aria-label="Recording a voice note"
              className="flex min-h-[42px] flex-1 items-center gap-3 px-2"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault()
                  void finishRecording(false)
                }
              }}
            >
              <span aria-hidden="true" className="size-2.5 animate-[pulse-soft_1.2s_ease-in-out_infinite] rounded-full bg-danger-text" />
              <span className="data text-text" role="timer" aria-live="off">
                {formatClock(recordedMs)} <span className="text-text-muted">/ {formatClock(MAX_VOICE_MS)}</span>
              </span>
              <span className="flex-1 text-sm text-text-muted">Recording…</span>
              <Button variant="ghost" size="sm" autoFocus onClick={() => void finishRecording(false)}>
                <Trash2 />
                Cancel
              </Button>
            </div>
          ) : (
            <>
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
                disabled
                  ? disabledHint
                  : editing
                    ? 'Edit your message'
                    : attachments.length
                      ? 'Add a caption (optional)'
                      : `Message ${peerName}`
              }
              onChange={(e) => update(e.target.value)}
              onBlur={stopTyping}
              onPaste={(e) => {
                const pasted = [...e.clipboardData.files]
                if (pasted.length) {
                  e.preventDefault()
                  addFiles(pasted)
                }
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  void send()
                } else if (e.key === 'Escape' && mode) {
                  e.preventDefault()
                  cancelMode()
                } else if (e.key === 'ArrowUp' && !mode && text === '' && attachments.length === 0) {
                  e.preventDefault()
                  onEditLast()
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
            </>
          )}
          {recording ? (
            <Button size="icon-lg" aria-label="Send voice note" onClick={() => void finishRecording(true)}>
              <Square className="fill-current" />
            </Button>
          ) : canRecord ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button size="icon-lg" variant="secondary" aria-label="Record a voice note" onClick={() => void startRecording()}>
                  <Mic />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Record a voice note (up to 5 minutes)</TooltipContent>
            </Tooltip>
          ) : (
            <Button
              size="icon-lg"
              aria-label={sending ? 'Sending…' : editing ? 'Save edit' : 'Send message'}
              disabled={!canSend}
              onClick={() => void send()}
            >
              {sending ? <LoaderCircle className="animate-spin" /> : editing ? <Check /> : <SendHorizontal />}
            </Button>
          )}
        </div>
        {error ? (
          <div id="composer-error" role="alert" className="mx-1 mt-1.5 flex items-start gap-1.5 text-xs text-danger-text">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
            {error}
          </div>
        ) : (
          <div className="data mx-1 mt-1.5 text-text-muted">
            <kbd className="font-[inherit] text-text">ENTER</kbd> {editing ? 'save' : 'send'} · <kbd className="font-[inherit] text-text">SHIFT+ENTER</kbd> new line ·{' '}
            {mode ? (
              <>
                <kbd className="font-[inherit] text-text">ESC</kbd> cancel
              </>
            ) : (
              <>
                <kbd className="font-[inherit] text-text">↑</kbd> edit last · drop or paste files
              </>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
