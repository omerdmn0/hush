import { useEffect, useState, type ReactNode } from 'react'
import { Check, CircleAlert, LoaderCircle, ShieldAlert, ShieldCheck } from 'lucide-react'
import type { PairingState } from '../../../shared/types'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { HudLabel } from '@/components/common'
import { cn } from '@/lib/utils'

/** "k7p4q" → "K7P4-Q" as you type. */
function formatInput(raw: string): string {
  const clean = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8)
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean
}

function useCountdown(until: number | null): string {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!until) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [until])
  if (!until) return ''
  const s = Math.max(0, Math.round((until - now) / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Identity check (shown instead of the chat until both computers are paired): each person types
 * the code shown on the other screen. Read the codes to each other in person or on a phone call.
 */
export function PairingScreen({ pairing, peerName }: { pairing: PairingState; peerName: string }): ReactNode {
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const left = useCountdown(pairing.codeExpiresAt)

  if (pairing.status === 'mismatch') {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div role="alert" className="cut panel flex max-w-lg flex-col gap-3 px-7 py-6 [--edge-c:var(--danger-text)]">
          <h2 className="display m-0 flex items-center gap-2.5 text-base">
            <ShieldAlert aria-hidden="true" className="size-5 text-danger-text" />
            Identity changed
          </h2>
          <p className="m-0 text-sm leading-5 text-text-muted">
            The computer at {peerName}'s address isn't the one you paired with. That happens when {peerName} reinstalled Hush or
            restored a backup on a new computer — or when someone else is using that address. Hush refused the connection.
          </p>
          <p className="m-0 text-sm leading-5 text-text-muted">
            Ask {peerName} (in person or by phone) whether they reinstalled. Only then pair again.
          </p>
          <div>
            <Button variant="destructive" onClick={() => window.hush.forgetPairing()}>
              Pair again
            </Button>
          </div>
        </div>
      </div>
    )
  }

  if (!pairing.peerReachable) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div className="cut panel flex max-w-md flex-col items-center gap-2 px-8 py-7 text-center">
          <div className="reticle mb-1 p-2.5 text-cyan" aria-hidden="true">
            <ShieldCheck className="size-[30px]" />
          </div>
          <h2 className="m-0 text-base font-semibold">Pair with {peerName}</h2>
          <p className="m-0 text-text-muted">
            Before you can chat, you'll each type a code shown on the other's screen. That proves you're really connected to
            each other. Both of you need Hush open.
          </p>
          <p role="status" className="label m-0 mt-2 flex items-center gap-2">
            <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
            Waiting for {peerName} to come online
          </p>
        </div>
      </div>
    )
  }

  const submit = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    try {
      await window.hush.submitPairingCode(input)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-1 items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-[640px] flex-col gap-4">
        <div>
          <h2 className="display m-0 text-base">Pair with {peerName}</h2>
          <p className="m-0 mt-1.5 text-sm leading-5 text-text-muted">
            Read the codes to each other in person or on a phone call — not by message. Each of you types the code shown on the
            other's screen.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <section aria-labelledby="my-code-h" className="cut panel flex flex-col gap-3 px-5 pt-4 pb-5">
            <HudLabel>
              <span id="my-code-h">Your code</span>
            </HudLabel>
            <div
              className="font-mono text-[30px] leading-10 font-bold tracking-[0.18em] text-cyan [text-shadow:var(--glow)]"
              aria-label={`Your code: ${pairing.code?.split('').join(' ')}`}
            >
              {pairing.code}
            </div>
            <div className="data text-text-muted">Expires in {left}</div>
            <div role="status" className={cn('flex items-center gap-1.5 text-sm', pairing.theyEnteredMyCode ? 'text-online' : 'text-text-muted')}>
              {pairing.theyEnteredMyCode ? <Check aria-hidden="true" className="size-4" /> : <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />}
              {pairing.theyEnteredMyCode ? `${peerName} entered your code` : `Waiting for ${peerName} to type it…`}
            </div>
          </section>

          <section aria-labelledby="their-code-h" className="cut panel flex flex-col gap-3 px-5 pt-4 pb-5">
            <HudLabel>
              <span id="their-code-h">{peerName}'s code</span>
            </HudLabel>
            {pairing.iEnteredTheirCode ? (
              <div role="status" className="flex flex-1 items-center gap-1.5 text-sm text-online">
                <Check aria-hidden="true" className="size-4" />
                Code accepted
              </div>
            ) : (
              <form
                className="flex flex-col gap-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  void submit()
                }}
              >
                <Label htmlFor="pair-code" className="sr-only">
                  Code shown on {peerName}'s screen
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="pair-code"
                    value={input}
                    onChange={(e) => setInput(formatInput(e.target.value))}
                    placeholder="XXXX-XXXX"
                    autoComplete="off"
                    spellCheck={false}
                    autoFocus
                    aria-invalid={pairing.error ? true : undefined}
                    aria-describedby="pair-code-help"
                    className="font-mono text-base tracking-[0.12em]"
                  />
                  <Button type="submit" disabled={busy || input.replace('-', '').length !== 8}>
                    Verify
                  </Button>
                </div>
                {pairing.error ? (
                  <span id="pair-code-help" role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
                    <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
                    {pairing.error}
                  </span>
                ) : (
                  <span id="pair-code-help" className="text-xs text-text-muted">
                    Type the 8 characters shown on {peerName}'s screen.
                  </span>
                )}
              </form>
            )}
          </section>
        </div>

        <p className="data m-0 text-text-muted">
          Your device ID {pairing.myFingerprint}
          {pairing.peerFingerprint && ` · ${peerName}'s ${pairing.peerFingerprint}`}
        </p>
      </div>
    </div>
  )
}
