import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Copy, RefreshCw, Upload, X } from 'lucide-react'
import { checkPeerIp, type PeerIpProblem } from '../../../../shared/ip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Avatar, StatusTag } from '@/components/common'
import { cn } from '@/lib/utils'

export interface Settings {
  displayName: string
  peerIp: string
  notifications: boolean
}

const SECTIONS = [
  { id: 'profile', title: 'Profile' },
  { id: 'connection', title: 'Connection' },
  { id: 'audio', title: 'Audio' },
  { id: 'notifications', title: 'Notifications' }
] as const
export type SectionId = (typeof SECTIONS)[number]['id']

const IP_ERRORS: Record<Exclude<PeerIpProblem, 'empty'>, string> = {
  'not-ipv4': "That doesn't look like an IP address. It should look like 100.x.x.x.",
  'not-tailscale': "That isn't a Tailscale IP. Tailscale IPs start with 100.",
  'is-self': "That's your own IP. Enter the other person's Tailscale IP."
}

export function SettingsScreen({
  settings,
  onChange,
  ownIp,
  onRefreshOwnIp,
  onClose,
  initialSection = 'profile'
}: {
  settings: Settings
  onChange: (patch: Partial<Settings>) => void
  ownIp: string | null | undefined
  onRefreshOwnIp: () => void
  onClose: () => void
  initialSection?: SectionId
}): ReactNode {
  const [current, setCurrent] = useState<string>(initialSection)
  const initialNav = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    initialNav.current?.focus()
    document.getElementById(`settings-${initialSection}`)?.scrollIntoView({ block: 'start' })
  }, [initialSection])

  const goTo = (id: string): void => {
    setCurrent(id)
    document.getElementById(`settings-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  return (
    <div className="flex min-w-0 flex-1">
      <nav aria-label="Settings sections" className="flex w-60 flex-none flex-col gap-0.5 border-r border-edge bg-sidebar px-3 py-[18px]">
        <div className="display mx-3 mb-0.5 text-sm">Settings</div>
        <div className="label mx-3 mb-3.5">
          <span aria-hidden="true">// </span>System config
        </div>
        {SECTIONS.map((s, i) => (
          <button
            key={s.id}
            ref={s.id === initialSection ? initialNav : undefined}
            aria-current={current === s.id ? 'true' : undefined}
            onClick={() => goTo(s.id)}
            className={cn(
              'flex h-[38px] items-center gap-2.5 rounded-sm border-l-2 border-transparent px-3 text-left font-mono text-[13px] font-semibold tracking-[0.06em] text-text-muted uppercase',
              'hover:bg-hover hover:text-text aria-[current=true]:border-cyan aria-[current=true]:bg-cyan-subtle aria-[current=true]:text-text'
            )}
          >
            <span aria-hidden="true" className={cn('opacity-60', current === s.id && 'text-cyan opacity-100')}>
              {String(i + 1).padStart(2, '0')}
            </span>
            {s.title}
          </button>
        ))}
      </nav>

      <div className="hud-grid relative flex-1 overflow-y-auto">
        <div className="sticky top-4 z-10 float-right mt-4 mr-4 flex flex-col items-center gap-1">
          <Button variant="secondary" size="icon" aria-label="Close settings" onClick={onClose}>
            <X className="size-5" />
          </Button>
          <span className="label" aria-hidden="true">
            Esc
          </span>
        </div>

        <div className="flex max-w-[700px] flex-col gap-5 px-10 pt-7 pb-16">
          <Module index={1} id="profile" title="Profile">
            <div className="flex items-center gap-4">
              <div className="reticle">
                <Avatar name={settings.displayName || 'You'} who="me" size={80} />
              </div>
              <div className="flex flex-col gap-2">
                <div className="flex gap-2">
                  <Button variant="secondary" aria-disabled>
                    <Upload />
                    Change avatar
                  </Button>
                </div>
                <span className="text-xs text-text-muted">Custom avatars aren't available yet.</span>
              </div>
            </div>
            <NameField value={settings.displayName} onSave={(displayName) => onChange({ displayName })} />
          </Module>

          <Module index={2} id="connection" title="Connection">
            <div className="cut panel panel-sm flex items-center gap-3 px-3.5 py-3 [--fill-c:var(--sunken)]">
              <StatusTag online={false} />
              <div className="flex-1">
                <div className="font-semibold">Not connected</div>
                <div className="text-xs text-text-muted">
                  {settings.peerIp ? 'Connecting arrives in the next build. Messages you send wait in the queue.' : 'Add the other person’s IP below.'}
                </div>
              </div>
            </div>
            <OwnIpField ownIp={ownIp} onRefresh={onRefreshOwnIp} />
            <PeerIpField value={settings.peerIp} ownIp={ownIp ?? null} onSave={(peerIp) => onChange({ peerIp })} />
          </Module>

          <Module index={3} id="audio" title="Audio">
            <DeviceSelect id="mic" label="Microphone" />
            <DeviceSelect id="speaker" label="Speaker" />
            <p className="m-0 text-xs text-text-muted">Device selection is wired up together with voice calls.</p>
          </Module>

          <Module index={4} id="notifications" title="Notifications">
            <div className="flex items-start justify-between gap-6">
              <div>
                <Label htmlFor="notif" className="mb-0.5">
                  Desktop notifications
                </Label>
                <div id="notif-help" className="text-xs text-text-muted">
                  Show a notification when the other person messages or calls you while Hush isn't focused.
                </div>
              </div>
              <Switch
                id="notif"
                aria-describedby="notif-help"
                checked={settings.notifications}
                onCheckedChange={(notifications) => onChange({ notifications })}
              />
            </div>
          </Module>
        </div>
      </div>
    </div>
  )
}

function Module({ index, id, title, children }: { index: number; id: string; title: string; children: ReactNode }): ReactNode {
  return (
    <section id={`settings-${id}`} aria-labelledby={`settings-${id}-h`} className="cut panel flex scroll-mt-6 flex-col gap-[18px] px-6 pt-5 pb-6">
      <h2 id={`settings-${id}-h`} className="display m-0 flex items-center gap-2.5 text-base leading-6">
        <span aria-hidden="true" className="text-magenta [text-shadow:none]">
          {String(index).padStart(2, '0')} //
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

function SavedMark(): ReactNode {
  return (
    <span className="label ml-1.5 inline-flex items-center gap-1 text-online">
      <Check aria-hidden="true" className="size-3.5" />
      Saved
    </span>
  )
}

function NameField({ value, onSave }: { value: string; onSave: (v: string) => void }): ReactNode {
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState(false)
  const commit = (): void => {
    const v = draft.trim()
    if (v === value) return
    onSave(v)
    setSaved(true)
  }
  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <Label htmlFor="display-name">Display name</Label>
      <Input
        id="display-name"
        value={draft}
        maxLength={40}
        placeholder="Your name"
        aria-describedby="display-name-help"
        onChange={(e) => {
          setDraft(e.target.value)
          setSaved(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      <span id="display-name-help" className="text-xs text-text-muted" aria-live="polite">
        How your name appears to the other person.
        {saved && <SavedMark />}
      </span>
    </div>
  )
}

function OwnIpField({ ownIp, onRefresh }: { ownIp: string | null | undefined; onRefresh: () => void }): ReactNode {
  const [copied, setCopied] = useState(false)
  const copy = async (): Promise<void> => {
    if (!ownIp) return
    await navigator.clipboard.writeText(ownIp)
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }
  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <span id="own-ip-label" className="text-sm font-semibold">
        Your Tailscale IP
      </span>
      <div className="flex items-center gap-2">
        <Input
          readOnly
          aria-labelledby="own-ip-label"
          aria-describedby="own-ip-help"
          value={ownIp ?? (ownIp === null ? 'Not detected' : 'Checking…')}
          className={cn('font-mono tracking-[0.04em]', !ownIp && 'text-text-muted')}
        />
        {ownIp ? (
          <Button variant="secondary" onClick={copy}>
            <Copy />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onRefresh} disabled={ownIp === undefined}>
            <RefreshCw />
            Retry
          </Button>
        )}
      </div>
      <span id="own-ip-help" className="text-xs text-text-muted" aria-live="polite">
        {ownIp
          ? 'Detected from Tailscale. Send this to the other person so they can add you.'
          : ownIp === null
            ? 'Tailscale isn’t running on this computer, or isn’t logged in. Start it, then press Retry.'
            : 'Looking for Tailscale…'}
      </span>
    </div>
  )
}

function PeerIpField({ value, ownIp, onSave }: { value: string; ownIp: string | null; onSave: (v: string) => void }): ReactNode {
  const [draft, setDraft] = useState(value)
  const [problem, setProblem] = useState<PeerIpProblem | null>(null)
  const [saved, setSaved] = useState(false)

  const commit = (): void => {
    const v = draft.trim()
    const p = checkPeerIp(v, ownIp)
    setProblem(p)
    if ((p === null || p === 'empty') && v !== value) {
      onSave(v)
      setSaved(p === null)
    }
  }
  const error = problem && problem !== 'empty' ? IP_ERRORS[problem] : null

  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <Label htmlFor="peer-ip">Their Tailscale IP</Label>
      <Input
        id="peer-ip"
        value={draft}
        placeholder="100.x.x.x"
        inputMode="decimal"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby="peer-ip-help"
        className="font-mono tracking-[0.04em]"
        onChange={(e) => {
          setDraft(e.target.value)
          setSaved(false)
        }}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && commit()}
      />
      {error ? (
        <span id="peer-ip-help" role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
          {error}
        </span>
      ) : (
        <span id="peer-ip-help" className="text-xs text-text-muted">
          Starts with 100. It's shown in the other person's Tailscale app. Hush only accepts connections from this address.
          {saved && <SavedMark />}
        </span>
      )}
    </div>
  )
}

function DeviceSelect({ id, label }: { id: string; label: string }): ReactNode {
  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select disabled defaultValue="default">
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="default">System default</SelectItem>
        </SelectContent>
      </Select>
    </div>
  )
}
