import type { UpdateState } from '../shared/types'

/** The parts of electron-updater's `autoUpdater` Hush uses. */
export interface UpdateEngine {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  isUpdaterActive(): boolean
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null>
  downloadUpdate(): Promise<string[]>
  quitAndInstall(isSilent: boolean, isForceRunAfter: boolean): void
  on(event: 'download-progress', listener: (progress: { percent: number }) => void): unknown
  on(event: 'error', listener: (error: Error) => void): unknown
}

export interface UpdaterDeps {
  /** Loaded on first use, so nothing update-related runs until the user asks. */
  engine: () => Promise<UpdateEngine>
  /** Why restarting now would interrupt something, if it would. */
  busy: () => string | null
  emit: (state: UpdateState) => void
}

/** Checks for, downloads and installs updates, only ever when the user clicks. */
export class Updater {
  private current: UpdateState = { status: 'idle' }
  private loaded: UpdateEngine | null = null

  constructor(private readonly deps: UpdaterDeps) {}

  get state(): UpdateState {
    return this.current
  }

  async check(): Promise<void> {
    if (['checking', 'downloading', 'installing'].includes(this.current.status)) return
    this.set({ status: 'checking' })
    try {
      const engine = await this.engine()
      if (!engine.isUpdaterActive()) return this.set({ status: 'unsupported' })
      const result = await engine.checkForUpdates()
      if (result?.isUpdateAvailable) this.set({ status: 'available', version: result.updateInfo.version })
      else this.set({ status: 'current' })
    } catch (e) {
      console.error('Update check failed:', e)
      this.set({ status: 'error', message: 'Couldn’t check for updates. Make sure you’re online and try again.' })
    }
  }

  async download(): Promise<void> {
    if (this.current.status !== 'available') return
    const { version } = this.current
    this.set({ status: 'downloading', version, percent: 0 })
    try {
      await (await this.engine()).downloadUpdate()
      this.set({ status: 'ready', version })
    } catch (e) {
      console.error('Update download failed:', e)
      this.set({ status: 'error', message: 'The download didn’t finish. Try again.' })
    }
  }

  /** Quits and installs. If that would interrupt something, it asks first (`anyway` confirms). */
  async install(anyway: boolean): Promise<void> {
    if (this.current.status !== 'ready') return
    const { version } = this.current
    const blocked = anyway ? null : this.deps.busy()
    if (blocked) return this.set({ status: 'ready', version, blocked })
    this.set({ status: 'installing', version })
    // Silently, then start the new version (failures arrive through the 'error' listener).
    ;(await this.engine()).quitAndInstall(true, true)
  }

  private async engine(): Promise<UpdateEngine> {
    if (this.loaded) return this.loaded
    const engine = await this.deps.engine()
    // Nothing may download or install without a click.
    engine.autoDownload = false
    engine.autoInstallOnAppQuit = false
    engine.on('download-progress', ({ percent }) => {
      if (this.current.status === 'downloading') this.set({ ...this.current, percent })
    })
    // Checking and downloading report failures by rejecting; installing only through this event.
    engine.on('error', (e) => {
      if (this.current.status === 'installing') {
        console.error('Update install failed:', e)
        this.set({ status: 'error', message: 'The update couldn’t be installed. Hush is still on the same version; check for updates to try again.' })
      }
    })
    return (this.loaded = engine)
  }

  private set(state: UpdateState): void {
    this.current = state
    this.deps.emit(state)
  }
}
