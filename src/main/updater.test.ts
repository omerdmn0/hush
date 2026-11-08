import { generateKeyPairSync, type KeyObject } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { releaseAllows, sha512File, signRelease } from './releaseManifest'
import { Updater, type UpdateEngine } from './updater'
import type { UpdateState } from '../shared/types'

const makeKeys = (): { privateKey: KeyObject; publicKey: string } => {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
}

class FakeEngine extends EventEmitter {
  autoDownload = true
  autoInstallOnAppQuit = true
  active = true
  isUpdaterActive = (): boolean => this.active
  checkForUpdates = vi.fn(async (): Promise<{ isUpdateAvailable: boolean; updateInfo: { version: string } } | null> => ({
    isUpdateAvailable: true,
    updateInfo: { version: '0.2.0' }
  }))
  downloadUpdate = vi.fn(async (): Promise<string[]> => [file])
  quitAndInstall = vi.fn()
}

let dir: string
let file: string
let engine: FakeEngine
let release: string
let busy: string | null
let states: UpdateState[]
const keys = makeKeys()

function updater(publicKey = keys.publicKey): Updater {
  return new Updater({
    publicKey,
    engine: async () => engine as unknown as UpdateEngine,
    fetchRelease: async () => release,
    busy: () => busy,
    emit: (s) => states.push(s)
  })
}

async function downloaded(u: Updater): Promise<void> {
  await u.check()
  await u.download()
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hush-updater-'))
  file = join(dir, 'update.AppImage')
  writeFileSync(file, 'the new version')
  engine = new FakeEngine()
  busy = null
  states = []
  release = signRelease('0.2.0', { 'Hush-x86_64.AppImage': await sha512File(file) }, keys.privateKey)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('release signature', () => {
  it('accepts the signed file for its version only', async () => {
    const hash = await sha512File(file)
    expect(releaseAllows(release, keys.publicKey, '0.2.0', hash)).toBe(true)
    expect(releaseAllows(release, keys.publicKey, '0.3.0', hash)).toBe(false)
    expect(releaseAllows(release, keys.publicKey, '0.2.0', 'f'.repeat(128))).toBe(false)
  })

  it('rejects another key, an edited list and junk', async () => {
    const hash = await sha512File(file)
    expect(releaseAllows(release, makeKeys().publicKey, '0.2.0', hash)).toBe(false)
    const { manifest, signature } = JSON.parse(release) as { manifest: string; signature: string }
    const edited = JSON.stringify({ manifest: manifest.replace('Hush-x86_64', 'Evil'), signature })
    expect(releaseAllows(edited, keys.publicKey, '0.2.0', hash)).toBe(false)
    expect(releaseAllows('not json', keys.publicKey, '0.2.0', hash)).toBe(false)
    expect(releaseAllows(release, 'not a key', '0.2.0', hash)).toBe(false)
  })
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
    const unsigned = updater('')
    engine.active = true
    await unsigned.check()
    expect(unsigned.state).toEqual({ status: 'unsupported' })
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
    finish([file])
    await download
    expect(u.state).toEqual({ status: 'ready', version: '0.2.0' })
  })

  it.each([
    ['tampered', (): void => writeFileSync(file, 'something else')],
    ['wrongly signed', (): void => void (release = signRelease('0.2.0', { x: 'y' }, makeKeys().privateKey))],
    ['for an older version', (): void => void (release = release.replace('0.2.0', '0.1.0'))]
  ])('throws away a %s download and never installs it', async (_name, spoil) => {
    spoil()
    const u = updater()
    await downloaded(u)
    expect(u.state.status).toBe('error')
    expect(existsSync(file)).toBe(false)
    await u.install(true)
    expect(engine.quitAndInstall).not.toHaveBeenCalled()
  })

  it('treats a missing signature as a failed check', async () => {
    const u = new Updater({
      publicKey: keys.publicKey,
      engine: async () => engine as unknown as UpdateEngine,
      fetchRelease: async () => Promise.reject(new Error('404')),
      busy: () => null,
      emit: () => {}
    })
    await downloaded(u)
    expect(u.state.status).toBe('error')
    expect(existsSync(file)).toBe(false)
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
