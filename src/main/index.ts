import { app, BrowserWindow, ipcMain, Menu, net as electronNet, protocol, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import icon from '../../resources/icon.png?asset'
import { DEFAULT_PORT, isCallSignal, MAX_TEXT_LENGTH, parseFrame } from '../shared/protocol'
import { isTailscaleIp } from '../shared/ip'
import { IPC, type HistoryCursor, type HushEvent, type NetState, type OutgoingImage, type Settings } from '../shared/types'
import { ChatService } from './chat'
import { HushDb } from './db'
import { ImageStore } from './images'
import { PeerLink } from './link'
import { findTailscaleIp } from './tailscale'

// ---------------------------------------------------------------------------
// Development-only overrides (ignored in packaged builds). They let two copies run
// on one machine over loopback, e.g. `npm run pair`:
//   HUSH_PROFILE    separate data folder + instance lock ("a", "b", …)
//   HUSH_BIND       listen address instead of the Tailscale IP (e.g. 127.0.0.1)
//   HUSH_PEER       peer address that bypasses the Tailscale-range check
//   HUSH_PORT       listen port      HUSH_PEER_PORT  port to dial
// ---------------------------------------------------------------------------
const dev = !app.isPackaged
const env = (k: string): string | undefined => (dev ? process.env[k] || undefined : undefined)
const profile = env('HUSH_PROFILE')
const port = Number(env('HUSH_PORT') ?? DEFAULT_PORT)
const peerPort = Number(env('HUSH_PEER_PORT') ?? DEFAULT_PORT)

if (dev) app.setPath('userData', join(app.getPath('appData'), profile ? `Hush-dev-${profile}` : 'Hush-dev'))

// Dev-only: fake microphone + auto-granted prompt, so calls can be tested without hardware.
if (env('HUSH_FAKE_MEDIA')) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream')
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream')
}
const devPairing = env('HUSH_PEER') !== undefined

// hush-img://<message-id>/thumb|full serves stored images to the UI (must be declared before ready).
protocol.registerSchemesAsPrivileged([{ scheme: 'hush-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// One Hush per data folder — a second copy would fight over the port and database.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  const send = (e: HushEvent): void => mainWindow?.webContents.send(IPC.event, e)

  const db = new HushDb(join(app.getPath('userData'), 'hush.db'))
  let selfId = db.getSetting<string>('selfId')
  if (!selfId) {
    selfId = randomUUID()
    db.setSetting('selfId', selfId)
  }
  let settings: Settings = {
    displayName: userInfo().username,
    peerIp: '',
    notifications: true,
    micId: '',
    speakerId: '',
    ...db.getSetting<Partial<Settings>>('settings')
  }

  const peerHostFor = (s: Settings): string | null => env('HUSH_PEER') ?? (s.peerIp || null)
  // What the UI sees: in dev pairing mode the override shows up as the configured peer.
  const visible = (s: Settings): Settings => (env('HUSH_PEER') ? { ...s, peerIp: env('HUSH_PEER')! } : s)
  const detectOwnIp = (): string | null => env('HUSH_BIND') ?? findTailscaleIp()

  const net: NetState = { ownIp: detectOwnIp(), port, listening: false, error: null }
  const link = new PeerLink({
    selfId,
    name: settings.displayName,
    bindHost: net.ownIp,
    port,
    peerHost: peerHostFor(settings),
    peerPort
  })
  const images = new ImageStore(join(app.getPath('userData'), 'images'))
  const chat = new ChatService(db, link, selfId, send, images)

  link.on('listening', (listening, error) => {
    Object.assign(net, { listening, error })
    send({ type: 'net', net: { ...net } })
  })
  link.on('problem', (message) => {
    net.error = message
    send({ type: 'net', net: { ...net } })
  })
  // Call signaling is relayed to the UI untouched (it holds the WebRTC connection).
  link.on('frame', (frame) => {
    if (isCallSignal(frame)) send({ type: 'call', signal: frame })
  })
  link.on('up', () => {
    if (net.error && net.listening) {
      net.error = null
      send({ type: 'net', net: { ...net } })
    }
  })

  // Tailscale may start (or change address) after Hush does.
  const refreshOwnIp = (): void => {
    const ip = detectOwnIp()
    if (ip === net.ownIp) return
    net.ownIp = ip
    link.update({ bindHost: ip })
    send({ type: 'net', net: { ...net } })
  }
  const ipPoll = setInterval(refreshOwnIp, 10_000)

  const createWindow = (): void => {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 780,
      minWidth: 880,
      minHeight: 560,
      show: false,
      title: profile ? `Hush (${profile})` : 'Hush',
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
    // Gather WebRTC candidates on every interface, so the Tailscale address is among them.
    mainWindow.webContents.setWebRTCIPHandlingPolicy('default')
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

    if (dev && process.env['ELECTRON_RENDERER_URL']) {
      mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
    } else {
      mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
    }
    mainWindow.on('closed', () => (mainWindow = null))
  }

  // ---------- IPC (inputs from the renderer are validated here) ----------

  ipcMain.handle(IPC.snapshot, () => ({ settings: visible(settings), peer: chat.peerState(), net: { ...net }, devPairing }))

  ipcMain.handle(IPC.callSignal, (_e, signal: unknown) => {
    // Same validation as frames from the network.
    const frame = parseFrame(JSON.stringify(signal ?? null))
    if (!frame || !isCallSignal(frame)) return false
    return link.send(frame)
  })

  ipcMain.handle(IPC.listMessages, (_e, before?: HistoryCursor, limit?: number) => {
    const cursor =
      before && Number.isFinite(before.sentAt) && typeof before.id === 'string' ? { sentAt: before.sentAt, id: before.id } : undefined
    return chat.listMessages(cursor, Number.isInteger(limit) ? (limit as number) : 100)
  })

  ipcMain.handle(IPC.sendMessage, (_e, text: unknown) => {
    if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new Error('Invalid message')
    return chat.send(text)
  })

  ipcMain.handle(IPC.sendImage, (_e, img: OutgoingImage, caption: unknown) => {
    if (!(img?.bytes instanceof Uint8Array) || !(img.thumb instanceof Uint8Array) || typeof caption !== 'string') {
      throw new Error('Invalid image')
    }
    return chat.sendImage(img, caption) // validates type, signature, size and preview
  })

  ipcMain.on(IPC.retryImage, (_e, id: unknown) => {
    if (typeof id === 'string') chat.transfers.retry(id)
  })

  ipcMain.on(IPC.markRead, (_e, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) chat.markRead(ids as string[])
  })

  ipcMain.on(IPC.setTyping, (_e, on: unknown) => {
    if (typeof on === 'boolean') chat.setTyping(on)
  })

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<Settings>) => {
    const next = { ...settings }
    if (typeof patch.displayName === 'string') next.displayName = patch.displayName.trim().slice(0, 40)
    if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications
    if (typeof patch.micId === 'string' && patch.micId.length <= 256) next.micId = patch.micId
    if (typeof patch.speakerId === 'string' && patch.speakerId.length <= 256) next.speakerId = patch.speakerId
    if (typeof patch.peerIp === 'string') {
      const ip = patch.peerIp.trim()
      if (ip !== '' && !isTailscaleIp(ip)) throw new Error('Not a Tailscale IP')
      next.peerIp = ip
    }
    settings = next
    db.setSetting('settings', settings)
    link.update({ name: settings.displayName, peerHost: peerHostFor(settings) })
    send({ type: 'settings', settings: visible(settings) })
    return visible(settings)
  })

  ipcMain.on(IPC.reconnect, () => {
    refreshOwnIp()
    link.reconnectNow()
  })

  // ---------- lifecycle ----------

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    if (app.isPackaged) Menu.setApplicationMenu(null)

    // Microphone (calls), notifications and clipboard writes are the only permissions Hush needs.
    const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))

    protocol.handle('hush-img', (req) => {
      const url = new URL(req.url)
      const id = url.hostname
      const file = images.resolve(id, url.pathname.slice(1), db.getMessage(id)?.image ?? null)
      return file ? electronNet.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
    })

    link.start()
    createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    clearInterval(ipPoll)
    link
      .stop()
      .catch(() => {})
      .finally(() => {
        db.close()
        app.quit()
      })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}
