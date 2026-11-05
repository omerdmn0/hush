import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { applyStartAtLogin, linuxAutostartEntry, type AutostartEnv } from './autostart'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })))

const env = (over: Partial<AutostartEnv>): AutostartEnv => {
  const configHome = mkdtempSync(join(tmpdir(), 'hush-autostart-'))
  dirs.push(configHome)
  return { platform: 'linux', packaged: true, execPath: '/opt/Hush/hush', configHome, setLoginItem: vi.fn(), ...over }
}

describe('start at login', () => {
  it('writes and removes the Linux autostart entry, launching hidden', () => {
    const e = env({})
    applyStartAtLogin(true, e)
    const file = join(e.configHome, 'autostart', 'hush.desktop')
    expect(readFileSync(file, 'utf8')).toContain('Exec="/opt/Hush/hush" --hidden')
    applyStartAtLogin(false, e)
    expect(existsSync(file)).toBe(false)
  })

  it('launches the AppImage file itself when running from one', () => {
    const e = env({ appImage: '/home/me/Apps/Hush 0.2.0.AppImage' })
    applyStartAtLogin(true, e)
    expect(readFileSync(join(e.configHome, 'autostart', 'hush.desktop'), 'utf8')).toContain('Exec="/home/me/Apps/Hush 0.2.0.AppImage" --hidden')
  })

  it('uses the login-item API on Windows', () => {
    const e = env({ platform: 'win32' })
    applyStartAtLogin(true, e)
    expect(e.setLoginItem).toHaveBeenCalledWith({ openAtLogin: true, args: ['--hidden'] })
  })

  it('never touches login items from a development build', () => {
    const e = env({ packaged: false })
    expect(applyStartAtLogin(true, e)).toBe('skipped')
    expect(existsSync(join(e.configHome, 'autostart'))).toBe(false)
    expect(e.setLoginItem).not.toHaveBeenCalled()
  })

  it('escapes special characters in the path', () => {
    expect(linuxAutostartEntry('/tmp/a"b$c')).toContain('Exec="/tmp/a\\"b\\$c" --hidden')
  })
})
