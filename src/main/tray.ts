import { Menu, nativeImage, Tray } from 'electron'
import { trayTooltip } from './notifyLogic'

export interface TrayState {
  peerName: string | null
  online: boolean
  unread: number
  notifications: boolean
}

interface TrayActions {
  open: () => void
  quit: () => void
  setNotifications: (on: boolean) => void
}

/**
 * Tray icon: Hush keeps running here when the window is closed.
 * The menu always has "Open Hush" because some Linux trays (AppIndicator) ignore clicks.
 */
export class HushTray {
  private readonly tray: Tray
  private readonly normal: Electron.NativeImage
  private readonly unread: Electron.NativeImage

  constructor(
    icons: { normal: string; unread: string },
    private readonly actions: TrayActions
  ) {
    // tray@2x.png / tray-unread@2x.png next to these files are picked up for HiDPI.
    this.normal = nativeImage.createFromPath(icons.normal)
    this.unread = nativeImage.createFromPath(icons.unread)
    this.tray = new Tray(this.normal)
    this.tray.on('click', () => actions.open())
  }

  update(s: TrayState): void {
    this.tray.setImage(s.unread > 0 ? this.unread : this.normal)
    this.tray.setToolTip(trayTooltip(s.peerName, s.online, s.unread))
    const status = s.peerName ? `${s.peerName} · ${s.online ? 'Online' : 'Offline'}` : 'No one linked yet'
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: s.unread > 0 ? `Open Hush (${s.unread} unread)` : 'Open Hush', click: () => this.actions.open() },
        { label: status, enabled: false },
        { type: 'separator' },
        {
          label: 'Desktop notifications',
          type: 'checkbox',
          checked: s.notifications,
          click: (item) => this.actions.setNotifications(item.checked)
        },
        { type: 'separator' },
        { label: 'Quit Hush', click: () => this.actions.quit() }
      ])
    )
  }

  destroy(): void {
    this.tray.destroy()
  }
}
