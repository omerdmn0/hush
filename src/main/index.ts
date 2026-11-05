import { app, BrowserWindow, ipcMain, Menu, nativeImage, net as electronNet, protocol, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import icon from '../../resources/icon.png?asset'
import trayIcon from '../../resources/tray.png?asset'
import trayUnreadIcon from '../../resources/tray-unread.png?asset'
import badgeIcon from '../../resources/badge.png?asset'
import { DEFAULT_PORT, isCallSignal, MAX_TEXT_LENGTH, parseFrame } from '../shared/protocol'
import { isTailscaleIp } from '../shared/ip'
import { IPC, type CallRecord, type HistoryCursor, type HushEvent, type NetState, type OutgoingImage, type Settings } from '../shared/types'
import { applyStartAtLogin, HIDDEN_FLAG } from './autostart'
import { Avatars } from './avatars'
import { CallTracker } from './callTracker'
import { ChatService } from './chat'
import { HushDb } from './db'
import { Identity } from './identity'
import { PairingService } from './pairing'
import { ImageStore } from './images'
import { PeerLink } from './link'
import { Notifier } from './notifier'
import { titleWithUnread } from './notifyLogic'
import { findTailscaleIp } from './tailscale'
import { HushTray } from './tray'

// ---------------------------------------------------------------------------
// Development-only overrides (ignored in packaged builds). They let two copies run
// on one machine over loopback, e.g. `npm run pair`:
//   HUSH_PROFILE    separate data folder + instance lock ("a", "b", …)
//   HUSH_BIND       listen address instead of the Tailscale IP (e.g. 127.0.0.1)
//   HUSH_PEER       peer address that bypasses the Tailscale-range check
//   HUSH_PORT       listen port      HUSH_PEER_PORT  port to dial
//   HUSH_FAKE_MEDIA fake microphone for testing calls
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

// Windows needs an app id for notifications to show.
if (process.platform === 'win32') app.setAppUserModelId('app.hush.chat')

// hush-img://<message-id>/thumb|full and hush-img://avatar/self|peer serve stored images to the UI.
protocol.registerSchemesAsPrivileged([{ scheme: 'hush-img', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

// One Hush per data folder — a second copy would fight over the port and database.
// Launching Hush again while it runs in the tray brings its window back instead.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let mainWindow: BrowserWindow | null = null
  let tray: HushTray | null = null
  /** True once a real quit has started (the close button otherwise only hides the window). */
  let quitting = false

  const db = new HushDb(join(app.getPath('userData'), 'hush.db'))
  let selfId = db.getSetting<string>('selfId')
  if (!selfId) {
    selfId = randomUUID()
    db.setSetting('selfId', selfId)
  }
  // Long-term identity (Ed25519) and the key of the person we paired with.
  let identityKey = db.getSetting<string>('identityKey')
  if (!identityKey) {
    identityKey = Identity.generate()
    db.setSetting('identityKey', identityKey)
  }
  const identity = new Identity(identityKey)
  let pairedKey = db.getSetting<string | null>('pairedKey') ?? null
  const pins = {
    getPinned: () => pairedKey,
    setPinned: (key: string | null) => {
      pairedKey = key
      db.setSetting('pairedKey', key)
    }
  }
  const startHidden = process.argv.includes(HIDDEN_FLAG)

  let settings: Settings = {
    displayName: userInfo().username,
    peerIp: '',
    notifications: true,
    notificationPreview: false,
    startAtLogin: true,
    micId: '',
    speakerId: '',
    ...db.getSetting<Partial<Settings>>('settings')
  }

  const peerHostFor = (s: Settings): string | null => env('HUSH_PEER') ?? (s.peerIp || null)
  // What the UI sees: in dev pairing mode the override shows up as the configured peer.
  const visible = (s: Settings): Settings => (env('HUSH_PEER') ? { ...s, peerIp: env('HUSH_PEER')! } : s)
  const detectOwnIp = (): string | null => env('HUSH_BIND') ?? findTailscaleIp()

  // ---------- window helpers ----------

  const showWindow = (): void => {
    if (!mainWindow) return createWindow()
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  }
  const userIsLooking = (): boolean => !!mainWindow && mainWindow.isVisible() && mainWindow.isFocused()

  // ---------- core services ----------

  const notifier = new Notifier({
    enabled: () => settings.notifications,
    preview: () => settings.notificationPreview,
    focused: userIsLooking,
    peerName: () => chat.peerState().name ?? 'Peer',
    icon,
    onClick: showWindow,
    log: devPairing ? (line) => console.log(line) : undefined
  })

  let unread = 0
  let unreadTimer: ReturnType<typeof setTimeout> | undefined
  const updateTray = (): void => {
    const p = chat.peerState()
    tray?.update({ peerName: settings.peerIp || devPairing ? p.name : null, online: p.presence === 'online', unread, notifications: settings.notifications })
  }
  const refreshUnread = (): void => {
    const n = db.unreadCount(selfId)
    if (n === unread) return
    unread = n
    mainWindow?.setTitle(titleWithUnread(n) + (profile ? ` · ${profile}` : ''))
    app.setBadgeCount(n) // Linux (Unity/KDE launchers) and macOS; ignored elsewhere
    if (process.platform === 'win32') mainWindow?.setOverlayIcon(n > 0 ? nativeImage.createFromPath(badgeIcon) : null, n > 0 ? `${n} unread` : '')
    updateTray()
  }
  const scheduleUnread = (): void => {
    clearTimeout(unreadTimer)
    unreadTimer = setTimeout(refreshUnread, 100)
  }

  /** Every event for the UI also drives notifications, the unread count and the tray. */
  const send = (e: HushEvent): void => {
    mainWindow?.webContents.send(IPC.event, e)
    if (e.type === 'message' && e.message.from === 'peer') {
      notifier.message({ text: e.message.text, hasImage: !!e.message.image })
      scheduleUnread()
    } else if (e.type === 'status') {
      scheduleUnread()
    } else if (e.type === 'peer') {
      updateTray()
    }
  }

  const net: NetState = { ownIp: detectOwnIp(), port, listening: false, error: null }
  const link = new PeerLink({
    selfId,
    name: settings.displayName,
    appVersion: app.getVersion(),
    identity,
    pinned: pins.getPinned,
    bindHost: net.ownIp,
    port,
    peerHost: peerHostFor(settings),
    peerPort
  })
  const images = new ImageStore(join(app.getPath('userData'), 'images'))
  const avatars = new Avatars(app.getPath('userData'))
  const chat = new ChatService(db, link, selfId, send, images, { avatars })
  const calls = new CallTracker()
  const pairing = new PairingService(link, identity.publicKey, pins)
  pairing.on('change', (state) => send({ type: 'pairing', pairing: state }))

  const applyAutostart = (): void => {
    applyStartAtLogin(settings.startAtLogin, {
      platform: process.platform,
      packaged: app.isPackaged,
      execPath: process.execPath,
      appImage: process.env.APPIMAGE,
      configHome: process.env.XDG_CONFIG_HOME || join(app.getPath('home'), '.config'),
      setLoginItem: (s) => app.setLoginItemSettings(s)
    })
  }

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
    if (!isCallSignal(frame)) return
    const what = calls.fromPeer(frame)
    send({ type: 'call', signal: frame })
    if (what === 'incoming') {
      // Bring a hidden window back so the call can be answered, without stealing focus.
      if (mainWindow && !mainWindow.isVisible()) mainWindow.showInactive()
      mainWindow?.flashFrame(true)
      notifier.incomingCall()
    } else if (what === 'missed') {
      notifier.missedCall()
    }
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

  const applySettings = (next: Settings): Settings => {
    settings = next
    db.setSetting('settings', settings)
    link.update({ name: settings.displayName, peerHost: peerHostFor(settings) })
    send({ type: 'settings', settings: visible(settings) })
    updateTray()
    return visible(settings)
  }

  function createWindow(): void {
    mainWindow = new BrowserWindow({
      width: 1200,
      height: 780,
      minWidth: 880,
      minHeight: 560,
      show: false,
      title: titleWithUnread(unread) + (profile ? ` · ${profile}` : ''),
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

    // Started at login with --hidden: stay in the tray until opened.
    mainWindow.once('ready-to-show', () => !startHidden && mainWindow?.show())
    // The window title shows the unread count; don't let the page's <title> replace it.
    mainWindow.on('page-title-updated', (e) => e.preventDefault())
    mainWindow.on('focus', () => mainWindow?.flashFrame(false))
    // The page can't reliably tell whether it's hidden in the tray, so tell it.
    const reportActive = (): void => {
      setImmediate(() => mainWindow?.webContents.send(IPC.event, { type: 'window', active: userIsLooking() } satisfies HushEvent))
    }
    for (const ev of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore'] as const) mainWindow.on(ev as 'focus', reportActive)
    // Closing the window keeps Hush running in the tray, so messages and calls still arrive.
    mainWindow.on('close', (e) => {
      if (quitting) return
      e.preventDefault()
      mainWindow?.hide()
      if (!db.getSetting<boolean>('trayHintShown')) {
        db.setSetting('trayHintShown', true)
        notifier.info('Hush is still running', 'It stays in the tray so messages and calls reach you. Use Quit to close it completely.')
      }
    })
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

  const quitApp = (): void => {
    quitting = true
    app.quit()
  }

  // ---------- IPC (inputs from the renderer are validated here) ----------

  ipcMain.handle(IPC.snapshot, () => ({
    settings: visible(settings),
    peer: chat.peerState(),
    net: { ...net },
    avatars: avatars.urls(),
    windowActive: userIsLooking(),
    pairing: pairing.state(),
    appVersion: app.getVersion(),
    packaged: app.isPackaged,
    devPairing
  }))

  ipcMain.handle(IPC.callSignal, (_e, signal: unknown) => {
    // Same validation as frames from the network.
    const frame = parseFrame(JSON.stringify(signal ?? null))
    if (!frame || !isCallSignal(frame)) return false
    calls.fromUs(frame)
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

  ipcMain.handle(IPC.setAvatar, (_e, bytes: unknown) => {
    if (bytes !== null && !(bytes instanceof Uint8Array)) return false
    return chat.setAvatar(bytes) // validates signature and size
  })

  ipcMain.handle(IPC.listCalls, () => db.listCalls())

  ipcMain.on(IPC.logCall, (_e, record: CallRecord) => {
    try {
      db.logCall(record)
      send({ type: 'call-log', record: db.listCalls().find((c) => c.id === record.id.toLowerCase())! })
    } catch {
      // ignore malformed records
    }
  })

  ipcMain.on(IPC.retryImage, (_e, id: unknown) => {
    if (typeof id === 'string') chat.transfers.retry(id)
  })

  ipcMain.on(IPC.markRead, (_e, ids: unknown) => {
    if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
      chat.markRead(ids as string[])
      scheduleUnread()
    }
  })

  ipcMain.on(IPC.setTyping, (_e, on: unknown) => {
    if (typeof on === 'boolean') chat.setTyping(on)
  })

  ipcMain.handle(IPC.updateSettings, (_e, patch: Partial<Settings>) => {
    const next = { ...settings }
    if (typeof patch.displayName === 'string') next.displayName = patch.displayName.trim().slice(0, 40)
    if (typeof patch.notifications === 'boolean') next.notifications = patch.notifications
    if (typeof patch.notificationPreview === 'boolean') next.notificationPreview = patch.notificationPreview
    if (typeof patch.startAtLogin === 'boolean' && patch.startAtLogin !== settings.startAtLogin) {
      next.startAtLogin = patch.startAtLogin
      settings = next
      applyAutostart()
    }
    if (typeof patch.micId === 'string' && patch.micId.length <= 256) next.micId = patch.micId
    if (typeof patch.speakerId === 'string' && patch.speakerId.length <= 256) next.speakerId = patch.speakerId
    if (typeof patch.peerIp === 'string') {
      const ip = patch.peerIp.trim()
      if (ip !== '' && !isTailscaleIp(ip)) throw new Error('Not a Tailscale IP')
      next.peerIp = ip
    }
    return applySettings(next)
  })

  ipcMain.on(IPC.reconnect, () => {
    refreshOwnIp()
    link.reconnectNow()
  })

  ipcMain.on(IPC.quit, quitApp)

  ipcMain.handle(IPC.pairSubmit, (_e, code: unknown) => {
    if (typeof code === 'string' && code.length <= 32) return pairing.submitCode(code)
  })

  ipcMain.on(IPC.pairForget, () => pairing.forget())

  // ---------- lifecycle ----------

  app.on('second-instance', showWindow)

  app.whenReady().then(() => {
    if (app.isPackaged) Menu.setApplicationMenu(null)

    // Microphone (calls), notifications and clipboard writes are the only permissions Hush needs.
    const allowed = new Set(['media', 'notifications', 'clipboard-sanitized-write'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))

    protocol.handle('hush-img', (req) => {
      const url = new URL(req.url)
      const host = url.hostname
      const kind = url.pathname.slice(1)
      const file = host === 'avatar' ? avatars.resolve(kind) : images.resolve(host, kind, db.getMessage(host)?.image ?? null)
      return file ? electronNet.fetch(pathToFileURL(file).toString()) : new Response('Not found', { status: 404 })
    })

    tray = new HushTray(
      { normal: trayIcon, unread: trayUnreadIcon },
      {
        open: showWindow,
        quit: quitApp,
        setNotifications: (on) => applySettings({ ...settings, notifications: on })
      }
    )
    applyAutostart() // keeps the entry pointing at the current app location
    link.start()
    createWindow()
    refreshUnread()
    updateTray()
    app.on('activate', showWindow)
  })

  // Real quit (power button, tray "Quit Hush", Ctrl+Q, or the OS shutting down):
  // hang up any call properly, close the link, and never take longer than a second.
  let shuttingDown = false
  app.on('before-quit', (e) => {
    quitting = true
    if (shuttingDown) return
    shuttingDown = true
    e.preventDefault()
    clearInterval(ipPoll)
    const cleanup = (async () => {
      for (const id of calls.openCalls()) await link.send({ t: 'call-end', id, reason: 'hangup' })
      await link.stop()
    })().catch(() => {})
    void Promise.race([cleanup, new Promise((r) => setTimeout(r, 1000))]).finally(() => {
      tray?.destroy()
      db.close()
      app.exit(0)
    })
  })

  // The window is only hidden, never closed, until a real quit — so don't quit here.
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
