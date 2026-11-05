import { useEffect, useState, type ReactNode } from 'react'
import { CircleAlert, KeyRound, LoaderCircle, LockKeyhole } from 'lucide-react'
import type { LockInfo } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

/**
 * Shown in its own small window before Hush opens its data: enter the app password, choose one
 * (no system keychain), or retry the keychain.
 */
export function LockScreen(): ReactNode {
  const [info, setInfo] = useState<LockInfo | null>(null)
  const [password, setPassword] = useState('')
  const [repeat, setRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.hush.lockInfo().then(setInfo)
  }, [])

  if (!info) return null

  const submit = async (): Promise<void> => {
    if (busy) return
    if (info.mode === 'create' && password !== repeat) return setError('The two passwords don’t match.')
    setBusy(true)
    setError(null)
    try {
      const problem = await window.hush.lockSubmit(password)
      if (problem) {
        setError(problem)
        if (info.mode === 'unlock') setPassword('')
      }
    } finally {
      setBusy(false)
    }
  }

  const title = info.mode === 'create' ? 'Choose an app password' : info.mode === 'unlock' ? 'Unlock Hush' : 'Keychain locked'
  return (
    <main className="hud-grid flex min-h-screen items-center justify-center bg-app p-6 text-text">
      <form
        className="cut panel flex w-full max-w-[380px] flex-col gap-4 px-7 pt-6 pb-7"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="reticle mb-1 p-2.5 text-cyan" aria-hidden="true">
            {info.mode === 'keychain-error' ? <KeyRound className="size-[30px]" /> : <LockKeyhole className="size-[30px]" />}
          </div>
          <h1 className="display m-0 text-base">{title}</h1>
          <p className="m-0 text-sm leading-5 text-text-muted">
            {info.mode === 'create'
              ? `Your messages are stored encrypted. This computer has no system keychain (like GNOME Keyring or KWallet) to keep the key safe, so Hush protects it with a password instead. You'll enter it each time Hush starts.`
              : info.mode === 'unlock'
                ? 'Your messages are encrypted on this computer. Enter your app password to open them.'
                : `Hush keeps its key in ${info.osName}, which didn't hand it over. Unlock it (logging out and back in usually does), then try again.`}
          </p>
        </div>

        {info.mode !== 'keychain-error' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="lock-pw">{info.mode === 'create' ? 'New app password' : 'App password'}</Label>
            <Input
              id="lock-pw"
              type="password"
              autoFocus
              autoComplete={info.mode === 'create' ? 'new-password' : 'current-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              aria-invalid={!!error}
            />
          </div>
        )}
        {info.mode === 'create' && (
          <div className="flex flex-col gap-1">
            <Label htmlFor="lock-pw2">Type it again</Label>
            <Input id="lock-pw2" type="password" autoComplete="new-password" value={repeat} onChange={(e) => setRepeat(e.target.value)} />
            <span className="text-xs text-text-muted">At least 8 characters. If you forget it, your history can only come back from a backup or from the other computer.</span>
          </div>
        )}

        {error && (
          <span role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
            <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
            {error}
          </span>
        )}

        <Button type="submit" disabled={busy || (info.mode !== 'keychain-error' && password === '')}>
          {busy && <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
          {info.mode === 'create' ? 'Set password' : info.mode === 'unlock' ? 'Unlock' : 'Try again'}
        </Button>
      </form>
    </main>
  )
}
