import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Command-line flag for "started at login": stay hidden in the tray. */
export const HIDDEN_FLAG = '--hidden'

export interface AutostartEnv {
  platform: NodeJS.Platform
  /** Only installed builds register themselves — a dev run must never touch your login items. */
  packaged: boolean
  execPath: string
  /** Set when running from an AppImage: the AppImage file itself must be launched. */
  appImage?: string
  /** $XDG_CONFIG_HOME or ~/.config */
  configHome: string
  setLoginItem: (s: { openAtLogin: boolean; args: string[] }) => void
}

/** Freedesktop autostart entry (Linux). */
export function linuxAutostartEntry(exec: string): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Hush',
    'Comment=Private chat for two',
    `Exec="${exec.replace(/(["`$\\])/g, '\\$1')}" ${HIDDEN_FLAG}`,
    'Icon=hush',
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n')
}

/** Turns "start Hush when I log in" on or off for this computer. */
export function applyStartAtLogin(enabled: boolean, env: AutostartEnv): 'applied' | 'skipped' {
  if (!env.packaged) return 'skipped'
  if (env.platform === 'linux') {
    const dir = join(env.configHome, 'autostart')
    const file = join(dir, 'hush.desktop')
    if (enabled) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(file, linuxAutostartEntry(env.appImage ?? env.execPath))
    } else {
      rmSync(file, { force: true })
    }
    return 'applied'
  }
  env.setLoginItem({ openAtLogin: enabled, args: [HIDDEN_FLAG] })
  return 'applied'
}
