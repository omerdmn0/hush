import { useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Copy, Mic, RefreshCw, Upload, Volume2, X } from 'lucide-react'
import { checkPeerIp, type PeerIpProblem } from '../../../../shared/ip'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import type { NetState, Settings } from '../../../../shared/types'
import { Avatar, AvatarContext, StatusTag } from '@/components/common'
import { getMic } from '@/lib/call'
import { ImageError, imageErrorText, makeAvatar } from '@/lib/images'
import { IMAGE_MIME } from '../../../../shared/protocol'
import { Ringer } from '@/lib/ringtone'
import { useAudioDevices, type AudioDevice } from '@/lib/useAudioDevices'
import { cn } from '@/lib/utils'
import type { PeerView } from '@/lib/view'

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
  net,
  peer,
  onChange,
  onReconnect,
  onClose,
  initialSection = 'profile'
}: {
  settings: Settings
  net: NetState
  peer: PeerView | null
  onChange: (patch: Partial<Settings>) => Promise<void>
  onReconnect: () => void
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
            <AvatarField name={settings.displayName || 'You'} />
            <NameField value={settings.displayName} onSave={(displayName) => onChange({ displayName })} />
          </Module>

          <Module index={2} id="connection" title="Connection">
            <ConnectionStatus settings={settings} net={net} peer={peer} onReconnect={onReconnect} />
            <OwnIpField ownIp={net.ownIp} onRefresh={onReconnect} />
            <PeerIpField value={settings.peerIp} ownIp={net.ownIp} onSave={(peerIp) => onChange({ peerIp })} />
          </Module>

          <Module index={3} id="audio" title="Audio">
            <AudioSettings settings={settings} onChange={onChange} />
          </Module>

          <Module index={4} id="notifications" title="Notifications">
            <div className="flex items-start justify-between gap-6">
              <div>
                <Label htmlFor="notif" className="mb-0.5">
                  Desktop notifications
                </Label>
                <div id="notif-help" className="text-xs text-text-muted">
                  Show a notification when the other person messages or calls you while Hush isn't focused. Closing the window keeps Hush
                  running in the tray so messages and calls still reach you — use the power button to quit completely.
                </div>
              </div>
              <Switch
                id="notif"
                aria-describedby="notif-help"
                checked={settings.notifications}
                onCheckedChange={(notifications) => void onChange({ notifications })}
              />
            </div>
            <div className="flex items-start justify-between gap-6">
              <div>
                <Label htmlFor="notif-preview" className={cn('mb-0.5', !settings.notifications && 'opacity-50')}>
                  Show message text in notifications
                </Label>
                <div id="notif-preview-help" className="text-xs text-text-muted">
                  {settings.notificationPreview
                    ? 'Notifications show what was written. Anyone who can see your screen — including the lock screen — can read it.'
                    : 'Private: notifications only say “New message from …”, never what was written.'}
                </div>
              </div>
              <Switch
                id="notif-preview"
                aria-describedby="notif-preview-help"
                disabled={!settings.notifications}
                checked={settings.notificationPreview}
                onCheckedChange={(notificationPreview) => void onChange({ notificationPreview })}
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

function NameField({ value, onSave }: { value: string; onSave: (v: string) => Promise<void> }): ReactNode {
  const [draft, setDraft] = useState(value)
  const [saved, setSaved] = useState(false)
  const commit = (): void => {
    const v = draft.trim()
    if (v === value || v === '') {
      setDraft(value) // an empty name isn't allowed; restore the saved one
      return
    }
    void onSave(v).then(() => setSaved(true))
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
        How your name appears to the other person. Updates on their side right away when you're connected.
        {saved && <SavedMark />}
      </span>
    </div>
  )
}

function OwnIpField({ ownIp, onRefresh }: { ownIp: string | null; onRefresh: () => void }): ReactNode {
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
          value={ownIp ?? 'Not detected'}
          className={cn('font-mono tracking-[0.04em]', !ownIp && 'text-text-muted')}
        />
        {ownIp ? (
          <Button variant="secondary" onClick={copy}>
            <Copy />
            {copied ? 'Copied' : 'Copy'}
          </Button>
        ) : (
          <Button variant="secondary" onClick={onRefresh}>
            <RefreshCw />
            Retry
          </Button>
        )}
      </div>
      <span id="own-ip-help" className="text-xs text-text-muted" aria-live="polite">
        {ownIp
          ? 'Detected from Tailscale. Send this to the other person so they can add you.'
          : 'Tailscale isn’t running on this computer, or isn’t logged in. Start it, then press Retry.'}
      </span>
    </div>
  )
}

function PeerIpField({ value, ownIp, onSave }: { value: string; ownIp: string | null; onSave: (v: string) => Promise<void> }): ReactNode {
  const [draft, setDraft] = useState(value)
  const [problem, setProblem] = useState<PeerIpProblem | null>(null)
  const [saved, setSaved] = useState(false)

  const commit = (): void => {
    const v = draft.trim()
    const p = checkPeerIp(v, ownIp)
    setProblem(p)
    if ((p === null || p === 'empty') && v !== value) {
      void onSave(v).then(
        () => setSaved(p === null),
        () => setProblem('not-tailscale')
      )
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

const SYSTEM_DEFAULT = 'default'

function AudioSettings({ settings, onChange }: { settings: Settings; onChange: (patch: Partial<Settings>) => Promise<void> }): ReactNode {
  const { mics, speakers, refresh } = useAudioDevices()
  const unlabelled = mics.length > 0 && mics.every((m) => /^Microphone \d+$/.test(m.label))
  return (
    <>
      <DeviceSelect id="mic" label="Microphone" value={settings.micId} devices={mics} onChange={(micId) => void onChange({ micId })} />
      <MicTest micId={settings.micId} onPermission={refresh} />
      <DeviceSelect id="speaker" label="Speaker" value={settings.speakerId} devices={speakers} onChange={(speakerId) => void onChange({ speakerId })} />
      <div>
        <SpeakerTest speakerId={settings.speakerId} />
      </div>
      {unlabelled && <p className="m-0 text-xs text-text-muted">Device names appear after you test the microphone once.</p>}
    </>
  )
}

function DeviceSelect({
  id,
  label,
  value,
  devices,
  onChange
}: {
  id: string
  label: string
  value: string
  devices: AudioDevice[]
  onChange: (deviceId: string) => void
}): ReactNode {
  // A saved device that is currently unplugged shows as the system default.
  const current = devices.some((d) => d.id === value) ? value : SYSTEM_DEFAULT
  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={current} onValueChange={(v) => onChange(v === SYSTEM_DEFAULT ? '' : v)}>
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent position="popper">
          <SelectItem value={SYSTEM_DEFAULT}>System default</SelectItem>
          {devices.map((d) => (
            <SelectItem key={d.id} value={d.id}>
              {d.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

const METER_SEGMENTS = 24

/** Live input level from the chosen microphone, so you can check it before a call. */
function MicTest({ micId, onPermission }: { micId: string; onPermission: () => void }): ReactNode {
  const [testing, setTesting] = useState(false)
  const [level, setLevel] = useState(0)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!testing) return
    let stream: MediaStream | null = null
    let ctx: AudioContext | null = null
    let frame = 0
    let stopped = false
    getMic(micId)
      .then((s) => {
        if (stopped) return s.getTracks().forEach((t) => t.stop())
        stream = s
        onPermission() // labels become available now
        ctx = new AudioContext()
        const analyser = ctx.createAnalyser()
        analyser.fftSize = 512
        ctx.createMediaStreamSource(s).connect(analyser)
        const data = new Uint8Array(analyser.fftSize)
        const tick = (): void => {
          analyser.getByteTimeDomainData(data)
          let peak = 0
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128))
          setLevel(Math.min(1, peak / 64))
          frame = requestAnimationFrame(tick)
        }
        tick()
      })
      .catch(() => {
        setError('Hush can’t use your microphone. Check that it’s connected and that Hush is allowed to use it.')
        setTesting(false)
      })
    return () => {
      stopped = true
      cancelAnimationFrame(frame)
      stream?.getTracks().forEach((t) => t.stop())
      void ctx?.close()
      setLevel(0)
    }
  }, [testing, micId, onPermission])

  const lit = Math.round(level * METER_SEGMENTS)
  return (
    <div className="flex max-w-[420px] flex-col gap-1.5">
      <span id="mic-level" className="text-sm font-semibold">
        Input level
      </span>
      <div
        role="meter"
        aria-labelledby="mic-level"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(level * 100)}
        className="flex h-3 gap-[3px]"
      >
        {Array.from({ length: METER_SEGMENTS }, (_, i) => (
          <span key={i} className={cn('flex-1', i < lit ? (i >= 19 ? 'bg-queued' : 'bg-online') : 'bg-pressed')} />
        ))}
      </div>
      <div className="flex items-center gap-3">
        <Button variant="secondary" size="sm" onClick={() => (setError(null), setTesting((t) => !t))}>
          <Mic />
          {testing ? 'Stop test' : 'Test microphone'}
        </Button>
        <span className="text-xs text-text-muted">{testing ? 'Speak — the bars should move.' : 'Check your microphone before a call.'}</span>
      </div>
      {error && (
        <span role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
          {error}
        </span>
      )}
    </div>
  )
}

function SpeakerTest({ speakerId }: { speakerId: string }): ReactNode {
  const [playing, setPlaying] = useState(false)
  const play = (): void => {
    const ringer = new Ringer()
    ringer.start('incoming', speakerId)
    setPlaying(true)
    setTimeout(() => {
      ringer.stop()
      setPlaying(false)
    }, 1600)
  }
  return (
    <Button variant="secondary" size="sm" onClick={play} disabled={playing}>
      <Volume2 />
      {playing ? 'Playing…' : 'Play test sound'}
    </Button>
  )
}

function ConnectionStatus({
  settings,
  net,
  peer,
  onReconnect
}: {
  settings: Settings
  net: NetState
  peer: PeerView | null
  onReconnect: () => void
}): ReactNode {
  const online = peer?.presence === 'online'
  const name = peer?.name ?? 'the other person'
  let title: string
  let detail: string
  let problem = false
  if (online) {
    title = `Connected to ${name}`
    detail = `Direct over Tailscale · ${settings.peerIp}:${net.port}`
  } else if (!net.ownIp) {
    title = 'Tailscale isn’t running'
    detail = 'Start Tailscale on this computer. Hush connects automatically once it’s up.'
    problem = true
  } else if (net.error) {
    title = 'Can’t connect'
    detail = net.error
    problem = true
  } else if (!settings.peerIp) {
    title = 'Not set up'
    detail = 'Add the other person’s Tailscale IP below.'
  } else {
    title = `Waiting for ${name}`
    detail = `${name === 'the other person' ? 'Their' : `${name}'s`} Hush isn’t reachable right now. It keeps trying in the background; messages you send stay queued.`
  }
  return (
    <div
      role="status"
      className={cn(
        'cut panel panel-sm flex items-center gap-3 px-3.5 py-3 [--fill-c:var(--sunken)]',
        problem && '[--edge-c:var(--danger-text)]'
      )}
    >
      {problem ? (
        <CircleAlert aria-hidden="true" className="size-5 flex-none text-danger-text" />
      ) : (
        <StatusTag online={online} />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-semibold">{title}</div>
        <div className="text-xs text-text-muted">{detail}</div>
      </div>
      {!online && settings.peerIp && net.ownIp && (
        <Button variant="secondary" onClick={onReconnect}>
          <RefreshCw />
          Retry now
        </Button>
      )}
    </div>
  )
}

function AvatarField({ name }: { name: string }): ReactNode {
  const hasAvatar = useContext(AvatarContext).self !== null
  const picker = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async (bytes: Uint8Array | null): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      if (!(await window.hush.setAvatar(bytes))) setError('That picture couldn’t be used. Try a PNG, JPEG or WebP image.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex items-center gap-4">
      <div className="reticle">
        <Avatar name={name} who="me" size={80} />
      </div>
      <div className="flex flex-col gap-2">
        <input
          ref={picker}
          type="file"
          accept={IMAGE_MIME.filter((m) => m !== 'image/gif').join(',')}
          hidden
          onChange={(e) => {
            const file = e.target.files?.[0]
            e.target.value = ''
            if (!file) return
            void makeAvatar(file).then(apply, (err: unknown) =>
              setError(err instanceof ImageError ? imageErrorText(err) : 'That picture couldn’t be used.')
            )
          }}
        />
        <div className="flex gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => picker.current?.click()}>
            <Upload />
            {hasAvatar ? 'Change avatar' : 'Add avatar'}
          </Button>
          {hasAvatar && (
            <Button variant="ghost" disabled={busy} onClick={() => void apply(null)}>
              Remove
            </Button>
          )}
        </div>
        {error ? (
          <span role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
            {error}
          </span>
        ) : (
          <span className="text-xs text-text-muted">Cropped to a square. The other person sees it right away.</span>
        )}
      </div>
    </div>
  )
}
