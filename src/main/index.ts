import { app, BrowserWindow, ipcMain, Menu, session } from 'electron'
import { join } from 'node:path'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/types'
import { findTailscaleIp } from './tailscale'

// Only one Hush per computer — a second copy would fight over the chat port and database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null

  const createWindow = (): void => {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 780,
      minWidth: 880,
      minHeight: 560,
      show: false,
      title: 'Hush',
      backgroundColor: '#0D0B14',
      autoHideMenuBar: true,
      icon,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false
      }
    })

    mainWindow.once('ready-to-show', () => mainWindow?.show())

    // The renderer never opens new windows or navigates away from the app.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

    if (!app.isPackaged && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }

    mainWindow.on('closed', () => (mainWindow = null))
  }

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    if (app.isPackaged) Menu.setApplicationMenu(null)

    // Microphone (calls) and notifications are the only permissions Hush ever needs.
    const allowed = new Set(['media', 'notifications'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
      callback(allowed.has(permission))
    )

    ipcMain.handle(IPC.tailscaleIp, () => findTailscaleIp())

    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
