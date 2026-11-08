import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Updater, type UpdateEngine } from './updater'

class FakeEngine extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  active = true
  isUpdaterActive = (): boolean => this.active
  checkForUpdates = vi.fn(async (): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null> => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.2.0' }
  }))
  downloadUpdate = vi.fn(async (): Promise<string[]> => ['/tmp/update.AppImage'])
  quitAndInstall = vi.fn()
}

let engine: FakeEngine
let busy: string | null

function updater(): Updater {
  return new Updater({
    engine: async () => engine as unknown as UpdateEngine,
    busy: () => busy,
    emit: () => {}
  })
}

async function downloaded(u: Updater): Promise<void> {
  await u.check()
  await u.download()
}

beforeEach(() => {
  engine = new FakeEngine()
  busy = null
})

describe('Updater', () => {
  it('does nothing automatically', async () => {
    const u = updater()
    await u.check()
    expect(engine.autoDownload).toBe(false)
    expect(engine.autoInstallOnAppQuit).toBe(false)
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(u.state).toEqual({ status: 'available', version: '0.2.0' })
  })

  it('reports being up to date', async () => {
    engine.checkForUpdates.mockResolvedValue({ isUpdateAvailable: false, updateInfo: { version: '0.1.0' } })
    const u = updater()
    await u.check()
    expect(u.state).toEqual({ status: 'current' })
  })

  it('explains when this copy can’t update', async () => {
    engine.active = false
    const u = updater()
    await u.check()
    expect(u.state).toEqual({ status: 'unsupported' })
    expect(engine.checkForUpdates).not.toHaveBeenCalled()
  })

  it('survives a failed check and a failed download', async () => {
    engine.checkForUpdates.mockRejectedValueOnce(new Error('offline'))
    const u = updater()
    await u.check()
    expect(u.state.status).toBe('error')
    await u.check()
    expect(u.state.status).toBe('available')
    engine.downloadUpdate.mockRejectedValueOnce(new Error('cut off'))
    await u.download()
    expect(u.state.status).toBe('error')
  })

  it('shows download progress, then is ready', async () => {
    let finish: (paths: string[]) => void = () => {}
    engine.downloadUpdate.mockReturnValue(new Promise((r) => (finish = r)))
    const u = updater()
    await u.check()
    const download = u.download()
    await vi.waitFor(() => expect(engine.downloadUpdate).toHaveBeenCalled())
    engine.emit('download-progress', { percent: 42 })
    expect(u.state).toEqual({ status: 'downloading', version: '0.2.0', percent: 42 })
    finish(['/tmp/update.AppImage'])
    await download
    expect(u.state).toEqual({ status: 'ready', version: '0.2.0' })
  })

  it('asks before interrupting a call, and installs when confirmed', async () => {
    busy = 'You’re in a call.'
    const u = updater()
    await downloaded(u)
    await u.install(false)
    expect(u.state).toEqual({ status: 'ready', version: '0.2.0', blocked: 'You’re in a call.' })
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
    await u.install(true)
    expect(engine.quitAndInstall).toHaveBeenCalledWith(true, true)
  })

  it('reports a failed install', async () => {
    const u = updater()
    await downloaded(u)
    await u.install(false)
    expect(u.state.status).toBe('installing')
    engine.emit('error', new Error('read-only folder'))
    expect(u.state.status).toBe('error')
  })

  it('ignores clicks that don’t fit the current state', async () => {
    const u = updater()
    await u.download()
    await u.install(true)
    expect(engine.downloadUpdate).not.toHaveBeenCalled()
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })
})
