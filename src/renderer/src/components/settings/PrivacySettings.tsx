import { useState, type ReactNode } from 'react'
import { Check, CircleAlert, FolderOpen, LoaderCircle, LockKeyhole } from 'lucide-react'
import type { PrivacyState } from '../../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

const MIN = 8

function bytes(n: number): string {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function Feedback({ kind, children }: { kind: 'ok' | 'error'; children: ReactNode }): ReactNode {
  return kind === 'ok' ? (
    <span role="status" className="flex items-start gap-1.5 text-xs text-online">
      <Check aria-hidden="true" className="mt-px size-3.5 flex-none" />
      {children}
    </span>
  ) : (
    <span role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
      <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
      {children}
    </span>
  )
}

/** New password typed twice. `onSubmit` only fires when both match and are long enough. */
function NewPassword({
  id,
  label,
  submitLabel,
  busy,
  onSubmit,
  onCancel,
  children
}: {
  id: string
  label: string
  submitLabel: string
  busy: boolean
  onSubmit: (password: string) => void
  onCancel: () => void
  children?: ReactNode
}): ReactNode {
  const [a, setA] = useState('')
  const [b, setB] = useState('')
  const [error, setError] = useState<string | null>(null)
  const submit = (): void => {
    if (a.length < MIN) return setError(`Use at least ${MIN} characters.`)
    if (a !== b) return setError('The two passwords don’t match.')
    setError(null)
    onSubmit(a)
  }
  return (
    <form
      className="flex max-w-[420px] flex-col gap-2.5 rounded-sm border border-edge bg-sunken p-4"
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-1`}>{label}</Label>
        <Input id={`${id}-1`} type="password" autoComplete="new-password" autoFocus value={a} onChange={(e) => setA(e.target.value)} />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${id}-2`}>Type it again</Label>
        <Input id={`${id}-2`} type="password" autoComplete="new-password" value={b} onChange={(e) => setB(e.target.value)} />
      </div>
      {children}
      {error && <Feedback kind="error">{error}</Feedback>}
      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          {submitLabel}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function Row({ title, help, helpId, children }: { title: ReactNode; help: ReactNode; helpId: string; children?: ReactNode }): ReactNode {
  return (
    <div className="flex items-start justify-between gap-6">
      <div>
        <div className="mb-0.5 text-sm font-semibold">{title}</div>
        <div id={helpId} className="text-xs text-text-muted">
          {help}
        </div>
      </div>
      {children}
    </div>
  )
}

export function PrivacySettings({ privacy, peerName, canAskPeer }: { privacy: PrivacyState; peerName: string; canAskPeer: boolean }): ReactNode {
  return (
    <>
      <div className="flex items-start gap-2.5 rounded-sm border border-edge bg-sunken px-4 py-3 text-xs text-text-muted">
        <LockKeyhole aria-hidden="true" className="mt-px size-4 flex-none text-cyan" />
        <span>
          Your messages, pictures and keys are stored <strong className="text-text">encrypted</strong> on this computer (AES-256). The
          key is protected by {privacy.protection === 'password' ? 'your app password' : privacy.osName}.
        </span>
      </div>
      <AppPassword privacy={privacy} peerName={peerName} />
      <BackupNow />
      <AutoBackupSettings privacy={privacy} />
      <Restore privacy={privacy} peerName={peerName} />
      {privacy.canRecover && <Recover peerName={peerName} canAskPeer={canAskPeer} />}
    </>
  )
}

function AppPassword({ privacy, peerName }: { privacy: PrivacyState; peerName: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<string | null>(null)
  const on = privacy.protection === 'password'
  const save = async (password: string | null): Promise<void> => {
    setBusy(true)
    try {
      await window.hush.setAppPassword(password)
      setDone(password === null ? 'App password removed.' : on ? 'App password changed.' : 'App password set. Hush will ask for it at every start.')
      setOpen(false)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2.5">
      <Row
        title="App password"
        helpId="apppw-help"
        help={
          on
            ? privacy.osAvailable
              ? 'Hush asks for it every time it starts.'
              : `Hush asks for it every time it starts. It's required here: this computer has no system keychain (like GNOME Keyring or KWallet).`
            : `Optional: ask for a password every time Hush starts. If you forget it, your history can only come back from a backup or from ${peerName}.`
        }
      >
        {!open && (
          <div className="flex flex-none gap-2">
            <Button variant="secondary" size="sm" aria-describedby="apppw-help" onClick={() => (setOpen(true), setDone(null))}>
              {on ? 'Change…' : 'Set password…'}
            </Button>
            {on && privacy.osAvailable && (
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(null)}>
                Remove
              </Button>
            )}
          </div>
        )}
      </Row>
      {open && (
        <NewPassword id="apppw" label={on ? 'New app password' : 'App password'} submitLabel="Save password" busy={busy} onSubmit={(p) => void save(p)} onCancel={() => setOpen(false)} />
      )}
      {done && <Feedback kind="ok">{done}</Feedback>}
    </div>
  )
}

function BackupNow(): ReactNode {
  const [open, setOpen] = useState(false)
  const [attachments, setAttachments] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)
  const run = async (password: string): Promise<void> => {
    setBusy(true)
    setResult(null)
    try {
      const r = await window.hush.backupNow(password, attachments)
      if (r.ok) {
        setResult({ kind: 'ok', text: `Saved ${bytes(r.bytes)} to ${r.path}. Keep the password safe — without it the backup can't be opened.` })
        setOpen(false)
      } else if (!('cancelled' in r)) {
        setResult({ kind: 'error', text: r.error })
      }
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2.5">
      <Row title="Backup" helpId="backup-help" help="One file with your whole history, protected by a password you choose. Store it somewhere safe, like a USB stick.">
        {!open && (
          <Button variant="secondary" size="sm" className="flex-none" aria-describedby="backup-help" onClick={() => (setOpen(true), setResult(null))}>
            Back up now…
          </Button>
        )}
      </Row>
      {open && (
        <NewPassword id="backup-pw" label="Backup password" submitLabel="Choose where to save…" busy={busy} onSubmit={(p) => void run(p)} onCancel={() => setOpen(false)}>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="backup-att" className="text-xs font-normal text-text-muted">
              Include full-size pictures (previews are always included)
            </Label>
            <Switch id="backup-att" checked={attachments} onCheckedChange={setAttachments} />
          </div>
        </NewPassword>
      )}
      {result && <Feedback kind={result.kind}>{result.text}</Feedback>}
    </div>
  )
}

function AutoBackupSettings({ privacy }: { privacy: PrivacyState }): ReactNode {
  const auto = privacy.autoBackup
  const [asking, setAsking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = async (patch: { enabled: boolean; attachments?: boolean; password?: string }): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      await window.hush.setAutoBackup(patch)
      setAsking(false)
    } catch (e) {
      setError((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-start justify-between gap-6">
        <div>
          <Label htmlFor="autobackup" className="mb-0.5">
            Weekly automatic backup
          </Label>
          <div id="autobackup-help" className="text-xs text-text-muted">
            {auto.enabled
              ? auto.last
                ? `Last backup ${new Date(auto.last).toLocaleString()}. The newest three are kept.`
                : 'The first backup is made within the hour. The newest three are kept.'
              : 'Saves a password-protected backup once a week while Hush runs.'}
          </div>
        </div>
        <Switch
          id="autobackup"
          aria-describedby="autobackup-help"
          checked={auto.enabled || asking}
          disabled={busy}
          onCheckedChange={(on) => (on ? setAsking(true) : (setAsking(false), void set({ enabled: false })))}
        />
      </div>
      {asking && !auto.enabled && (
        <NewPassword
          id="auto-pw"
          label="Password for automatic backups"
          submitLabel="Turn on"
          busy={busy}
          onSubmit={(password) => void set({ enabled: true, password })}
          onCancel={() => setAsking(false)}
        />
      )}
      {auto.enabled && (
        <div className="flex flex-col gap-2 border-l-2 border-edge pl-4">
          <div className="flex items-center gap-2">
            <span className="data min-w-0 flex-1 truncate text-text-muted" title={auto.folder}>
              {auto.folder}
            </span>
            <Button variant="secondary" size="sm" onClick={() => void window.hush.chooseBackupFolder()}>
              <FolderOpen aria-hidden="true" className="size-3.5" />
              Change folder…
            </Button>
          </div>
          <div className="flex items-center justify-between gap-4">
            <Label htmlFor="auto-att" className="text-xs font-normal text-text-muted">
              Include full-size pictures
            </Label>
            <Switch id="auto-att" checked={auto.attachments} disabled={busy} onCheckedChange={(attachments) => void set({ enabled: true, attachments })} />
          </div>
          {auto.error && <Feedback kind="error">Last automatic backup failed: {auto.error}</Feedback>}
        </div>
      )}
      {error && <Feedback kind="error">{error}</Feedback>}
    </div>
  )
}

function Restore({ privacy, peerName }: { privacy: PrivacyState; peerName: string }): ReactNode {
  const [open, setOpen] = useState(false)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      setError(await window.hush.restoreBackup(password)) // on success Hush restarts
    } finally {
      setBusy(false)
    }
  }
  const becomesAppPassword = privacy.protection === 'password' || !privacy.osAvailable
  return (
    <div className="flex flex-col gap-2.5">
      <Row title="Restore" helpId="restore-help" help="Replaces everything in Hush on this computer with a backup. Hush restarts afterwards.">
        {!open && (
          <Button variant="secondary" size="sm" className="flex-none" aria-describedby="restore-help" onClick={() => setOpen(true)}>
            Restore…
          </Button>
        )}
      </Row>
      {open && (
        <form
          className="flex max-w-[420px] flex-col gap-2.5 rounded-sm border border-edge bg-sunken p-4"
          onSubmit={(e) => {
            e.preventDefault()
            void run()
          }}
        >
          <div className="flex flex-col gap-1">
            <Label htmlFor="restore-pw">Backup password</Label>
            <Input id="restore-pw" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </div>
          <span className="text-xs text-text-muted">
            Anything newer than the backup comes back from {peerName} the next time you're both online
            {becomesAppPassword ? '. Afterwards, Hush asks for the backup password when it starts — you can change it here.' : '.'}
          </span>
          {error && <Feedback kind="error">{error}</Feedback>}
          <div className="flex gap-2">
            <Button type="submit" variant="destructive" size="sm" disabled={busy || password === ''}>
              {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
              Choose backup file…
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}

function Recover({ peerName, canAskPeer }: { peerName: string; canAskPeer: boolean }): ReactNode {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="flex flex-col gap-2.5">
      <Row
        title={`Recover history from ${peerName}`}
        helpId="recover-help"
        help={`Just reinstalled? ${peerName}'s computer still has your conversation, including your own messages and pictures. Hush takes it back and restarts. Only possible before you write anything here.`}
      >
        <Button
          variant="secondary"
          size="sm"
          className="flex-none"
          aria-describedby="recover-help"
          disabled={busy || !canAskPeer}
          onClick={async () => {
            setBusy(true)
            setError(null)
            try {
              setError(await window.hush.recoverHistory())
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy && <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />}
          Recover…
        </Button>
      </Row>
      {!canAskPeer && <span className="text-xs text-text-muted">Available once you're paired and {peerName} is online.</span>}
      {error && <Feedback kind="error">{error}</Feedback>}
    </div>
  )
}
