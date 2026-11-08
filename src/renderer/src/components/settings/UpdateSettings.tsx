import { useEffect, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Download, RefreshCw, RotateCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { UpdateState } from '../../../../shared/types'

function describe(state: UpdateState, packaged: boolean): string {
  if (!packaged) return 'Only available in the installed app (this is a development build).'
  switch (state.status) {
    case 'unsupported':
      return 'This copy of Hush can’t update itself. Download the new version from the project’s GitHub releases; your history stays.'
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Version ${state.version} is available. Your messages, files and pairing stay as they are.`
    case 'downloading':
      return `Downloading version ${state.version}…`
    case 'ready':
      return `Version ${state.version} is ready. Hush will close for a moment and reopen. Your messages, files and pairing stay as they are.`
    case 'installing':
      return `Installing version ${state.version}…`
    default:
      return 'Hush only contacts GitHub when you press this button.'
  }
}

function Action({ state, packaged }: { state: UpdateState; packaged: boolean }): ReactNode {
  if (state.status === 'available') {
    return (
      <Button size="sm" onClick={() => void window.hush.downloadUpdate()}>
        <Download aria-hidden="true" className="size-4" /> Download
      </Button>
    )
  }
  if (state.status === 'ready' || state.status === 'installing') {
    const anyway = state.status === 'ready' && !!state.blocked
    return (
      <Button size="sm" disabled={state.status === 'installing'} onClick={() => void window.hush.installUpdate(anyway)}>
        <RotateCw aria-hidden="true" className="size-4" /> {anyway ? 'Restart anyway' : 'Restart to update'}
      </Button>
    )
  }
  const busy = state.status === 'checking' || state.status === 'downloading'
  return (
    <Button variant="secondary" size="sm" disabled={!packaged || busy || state.status === 'unsupported'} onClick={() => void window.hush.checkForUpdate()}>
      <RefreshCw aria-hidden="true" className="size-4" /> Check for updates
    </Button>
  )
}

export function UpdateSettings({ appVersion, packaged }: { appVersion: string; packaged: boolean }): ReactNode {
  const [state, setState] = useState<UpdateState>({ status: 'idle' })
  useEffect(() => {
    void window.hush.updateState().then(setState)
    return window.hush.onEvent((e) => {
      if (e.type === 'update') setState(e.update)
    })
  }, [])

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-6">
        <div>
          <div className="mb-0.5 text-sm font-semibold">Hush {appVersion}</div>
          <div role="status" className="text-xs text-text-muted">
            {describe(state, packaged)}
          </div>
        </div>
        <div className="flex-none">
          <Action state={state} packaged={packaged} />
        </div>
      </div>
      {state.status === 'downloading' && (
        <div
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(state.percent)}
          className="h-1.5 overflow-hidden rounded-sm bg-hover"
        >
          <div className="h-full bg-cyan transition-[width]" style={{ width: `${state.percent}%` }} />
        </div>
      )}
      {state.status === 'current' && (
        <span role="status" className="flex items-start gap-1.5 text-xs text-online">
          <Check aria-hidden="true" className="mt-px size-3.5 flex-none" />
          You’re on the latest version.
        </span>
      )}
      {(state.status === 'error' || (state.status === 'ready' && state.blocked)) && (
        <span role="alert" className="flex items-start gap-1.5 text-xs text-danger-text">
          <CircleAlert aria-hidden="true" className="mt-px size-3.5 flex-none" />
          {state.status === 'error' ? state.message : state.blocked}
        </span>
      )}
    </div>
  )
}
