import { app, autoUpdater as nativeUpdater, BrowserWindow, desktopCapturer, dialog, ipcMain, Menu, nativeImage, protocol, safeStorage, session, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { userInfo } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import icon from '../../resources/icon.png?asset'
import trayIcon from '../../resources/tray.png?asset'
import trayUnreadIcon from '../../resources/tray-unread.png?asset'
import badgeIcon from '../../resources/badge.png?asset'
import { DEFAULT_PORT, GENERAL_CHANNEL, isCallSignal, MAX_TEXT_LENGTH, parseFrame, sniffImage } from '../shared/protocol'
import { isRiskyFile } from '../shared/files'
import { isTailscaleIp } from '../shared/ip'
import { IPC, type AutoBackup, type BackupResult, type CallRecord, type HistoryCursor, type HushEvent, type LockInfo, type NetState, type OutgoingImage, type PrivacyState, type ScreenAudioStarted, type ScreenAudioSupport, type Settings, type ShareOptions } from '../shared/types'
import { applyStartAtLogin, HIDDEN_FLAG } from './autostart'
import { Avatars } from './avatars'
import {
  applyStagedRestore,
  backupFileName,
  backupKeyFromPassword,
  extractBackup,
  markStagedRestoreReady,
  pruneBackups,
  STAGING,
  writeBackup,
  type BackupSource
} from './backup'
import { CallTracker } from './callTracker'
import { AWAITING_SYNC, ChatService } from './chat'
import { HushDb } from './db'
import { Identity } from './identity'
import { Keyring, type OsProtector } from './keyring'
import { PairingService } from './pairing'
import { blobOf, ImageStore } from './images'
import { PeerLink } from './link'
import { Notifier } from './notifier'
import { titleWithUnread } from './notifyLogic'
import { findTailscaleIp } from './tailscale'
import { LinuxScreenAudio, SOURCE_LABEL, type Run } from './screenAudioLinux'
import { WindowsScreenAudio, type HelperCommand } from './screenAudioWindows'
import { HushTray } from './tray'
import { Updater } from './updater'
import { fieldCipher } from './vault'

// ---------------------------------------------------------------------------
// Development-only overrides (ignored in packaged builds). They let two copies run
// on one machine over loopback, e.g. `npm run pair`:
//   HUSH_PROFILE    separate data folder + instance lock ("a", "b", …)
//   HUSH_BIND       listen address instead of the Tailscale IP (e.g. 127.0.0.1)
//   HUSH_PEER       peer address that bypasses the Tailscale-range check
//   HUSH_PORT       listen port      HUSH_PEER_PORT  port to dial
//   HUSH_FAKE_MEDIA fake microphone for testing calls
//   HUSH_SCREEN_AUDIO_HELPER  a .js stand-in for the Windows audio helper, to test that path on Linux
// ---------------------------------------------------------------------------
const dev = !app.isPackaged
// Debugging an installed Hush would expose the unlocked chat to any program on this computer.
// The fuses in electron-builder.yml block --inspect; these flags belong to Chromium, so they're
// refused here, before anything is unlocked.
if (!dev && ['remote-debugging-port', 'remote-debugging-pipe'].some((s) => app.commandLine.hasSwitch(s))) process.exit(1)
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

// Electron only uses the Linux keyring by itself on desktops it recognises (GNOME, Xfce,
// Cinnamon…). On others — Hyprland, Sway, i3… — it silently uses a fixed key instead. So ask for
// the Secret Service (GNOME Keyring, KeePassXC…) explicitly, except on KDE, where Electron picks
// KWallet itself, or when the user chose a store with --password-store.
if (process.platform === 'linux' && !app.commandLine.hasSwitch('password-store') && !/KDE/i.test(process.env.XDG_CURRENT_DESKTOP ?? '')) {
  app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
}

/**
 * The OS keychain via Electron safeStorage: DPAPI on Windows; the keyring on Linux.
 * On Linux, Electron can fall back to a hard-coded key — openly ("basic_text"), or silently when
 * the keyring isn't reachable (it still reports the keyring backend but writes "v10" data). Only
 * "v11" data is encrypted with a key kept in the keyring, so anything else counts as "no
 * keychain" and an app password is required instead. Dev-only HUSH_NO_KEYCHAIN simulates that.
 */
const osProtector: OsProtector = {
  available: async () => {
    if (env('HUSH_NO_KEYCHAIN') || !(await safeStorage.isAsyncEncryptionAvailable())) return false
    if (process.platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend())) return false
    try {
      await osProtector.encrypt('probe')
      return true
    } catch {
      return false
    }
  },
  name: () => {
    if (process.platform === 'win32') return 'Windows'
    if (process.platform === 'darwin') return 'macOS Keychain'
    return safeStorage.getSelectedStorageBackend().startsWith('kwallet') ? 'KWallet' : 'your system keyring'
  },
  encrypt: async (plain) => {
    const sealed = await safeStorage.encryptStringAsync(plain)
    if (process.platform === 'linux' && sealed.subarray(0, 3).toString() !== 'v11') throw new Error('The system keyring isn’t reachable')
    return sealed
  },
  decrypt: async (sealed) => (await safeStorage.decryptStringAsync(sealed)).result
}

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
  const userData = app.getPath('userData')
  const webPreferences = {
    preload: join(__dirname, '../preload/index.js'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    spellcheck: false // it would also fetch dictionaries from Google
  }
  const loadRenderer = (win: BrowserWindow, hash?: string): void => {
    if (dev && process.env['ELECTRON_RENDERER_URL']) void win.loadURL(process.env['ELECTRON_RENDERER_URL'] + (hash ? `#${hash}` : ''))
    else void win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
  }
  const quitApp = (): void => {
    quitting = true
    app.quit()
  }
  /**
   * Starts Hush again after this copy exits. The user is at the window, so it must not come back
   * hidden even if this copy was started at login.
   */
  const relaunch = (): void => {
    const args = process.argv.slice(1).filter((a) => a !== HIDDEN_FLAG)
    const image = process.env.APPIMAGE
    if (!image) return app.relaunch({ args })
    // app.relaunch can't work in an AppImage: its helper runs from the AppImage's mount, which
    // disappears when Hush exits. So wait from outside it, then start the AppImage file itself.
    spawn('/bin/sh', ['-c', 'while kill -0 "$0" 2>/dev/null; do sleep 0.2; done; exec "$@"', String(process.pid), image, ...args], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, LD_LIBRARY_PATH: undefined } // AppImage's library path would break the system's shell
    }).unref()
  }

  /** Set once the data is unlocked and Hush is running. */
  let core: { showWindow: () => void; shutdown: () => Promise<void>; close: () => void } | null = null

  // ---------- unlocking (before anything is opened) ----------

  let lockWindow: BrowserWindow | null = null
  let lockInfo: LockInfo | null = null
  let lockKeyring: Keyring | null = null
  let lockDone: ((key: Buffer) => void) | null = null

  /** The data key: from the keychain when possible, otherwise via the lock window. */
  async function obtainKey(keyring: Keyring): Promise<Buffer> {
    const mode = keyring.mode()
    const osName = keyring.osName()
    if (mode === 'os') {
      try {
        return await keyring.unlockWithKeychain()
      } catch (e) {
        lockInfo = { mode: 'keychain-error', osName, error: (e as Error).message }
      }
    } else if (mode === 'new' && (await keyring.osAvailable())) {
      return keyring.create()
    } else {
      lockInfo = { mode: mode === 'password' ? 'unlock' : 'create', osName }
    }
    lockKeyring = keyring
    return new Promise((resolve) => {
      lockDone = resolve
      openLockWindow()
    })
  }

  function openLockWindow(): void {
    lockWindow = new BrowserWindow({
      width: 480,
      height: 620,
      resizable: false,
      show: false,
      title: 'Hush' + (profile ? ` · ${profile}` : ''),
      backgroundColor: '#0D0B14',
      autoHideMenuBar: true,
      icon,
      webPreferences
    })
    lockWindow.once('ready-to-show', () => lockWindow?.show())
    lockWindow.on('closed', () => {
      lockWindow = null
      if (!core) quitApp()
    })
    lockWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    lockWindow.webContents.on('will-navigate', (event) => event.preventDefault())
    loadRenderer(lockWindow, 'lock')
  }

  ipcMain.handle(IPC.lockInfo, () => lockInfo)

  ipcMain.handle(IPC.lockSubmit, async (_e, password: unknown): Promise<string | null> => {
    const info = lockInfo
    const keyring = lockKeyring
    if (!info || !keyring || !lockDone || typeof password !== 'string' || password.length > 1024) return 'Something went wrong. Restart Hush.'
    let key: Buffer
    try {
      if (info.mode === 'create') {
        if (password.length < 8) return 'Use at least 8 characters.'
        key = await keyring.create(password)
      } else if (info.mode === 'unlock') {
        key = keyring.unlockWithPassword(password)
      } else {
        key = await keyring.unlockWithKeychain()
      }
    } catch {
      return info.mode === 'unlock' ? 'Wrong password.' : `${info.osName} still refused. Unlock it (log out and back in), then try again.`
    }
    const done = lockDone
    lockDone = null
    lockInfo = null
    done(key)
    return null
  })

  /**
   * The key doesn't open this data (e.g. the keychain was reset). Offer to set the data aside
   * and start fresh — then a backup can be restored or the history recovered from the peer.
   */
  function unreadableData(): void {
    const choice = dialog.showMessageBoxSync({
      type: 'error',
      title: 'Hush can’t open its data',
      message: 'The key that encrypts your Hush history on this computer is missing or has changed.',
      detail:
        'This happens if the system keychain was reset. You can start fresh: your old data is kept in a folder, and you can then restore a backup or recover your history from the other computer.',
      buttons: ['Quit', 'Start fresh'],
      defaultId: 0,
      cancelId: 0
    })
    if (choice === 1) {
      const aside = join(userData, `unreadable-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`)
      mkdirSync(aside)
      for (const name of readdirSync(userData)) {
        if (['hush.db', 'hush.db-wal', 'hush.db-shm', 'vault.json', 'images', 'avatar-self.img', 'avatar-peer.img'].includes(name)) {
          renameSync(join(userData, name), join(aside, name))
        }
      }
      relaunch()
    }
    app.exit(0)
  }

  /** Opens the data with the unlocked key and starts everything. */
  function startCore(dataKey: Buffer, keyring: Keyring, restored: boolean): void {
    const cipher = fieldCipher(dataKey)
    const db = new HushDb(join(userData, 'hush.db'), cipher)
    // Make sure this key really opens this data before touching anything.
    const keyCheck = db.getSetting<string>('keyCheck')
    if (keyCheck) {
      try {
        cipher.open(keyCheck)
      } catch {
        db.close()
        return unreadableData()
      }
    }
    let selfId = db.getSetting<string>('selfId')
    if (!selfId) {
      selfId = randomUUID()
      db.setSetting('selfId', selfId)
    }
    // Long-term identity (Ed25519) and the key of the person we paired with.
    const images = new ImageStore(join(userData, 'images'), dataKey)
    const avatars = new Avatars(userData, dataKey)
    // One-time upgrade of data stored before encryption existed (no-op for new installs).
    if (!keyCheck) {
      db.encryptExisting(['identityKey'])
      images.encryptExisting()
      avatars.encryptExisting()
      db.setSetting('keyCheck', cipher.seal('hush'))
    }
    db.sealAttachmentDetails()
    if (restored) db.setSetting(AWAITING_SYNC, true) // see ChatService.assertCanWrite
    let identityKey = db.getSecret<string>('identityKey')
    if (!identityKey) {
      identityKey = Identity.generate()
      db.setSecret('identityKey', identityKey)
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
      displayName: userInfo().username.slice(0, 40), // longer names are refused by the other app
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
      const n = chat.unread().total
      if (n === unread) return
      unread = n
      mainWindow?.setTitle(titleWithUnread(n) + (profile ? ` · ${profile}` : ''))
      app.setBadgeCount(n) // Linux (Unity/KDE launchers) and macOS; ignored elsewhere
      if (process.platform === 'win32') mainWindow?.setOverlayIcon(n > 0 ? nativeImage.createFromPath(badgeIcon) : null, n > 0 ? `${n} unread` : '')
      updateTray()
    }
    /** Set when Hush is closing, so nothing new touches the database. */
    let closing = false
    const scheduleUnread = (): void => {
      if (closing) return
      clearTimeout(unreadTimer)
      unreadTimer = setTimeout(refreshUnread, 100)
    }

    /** Until we write something, history can still be recovered from the other computer. */
    let recoverable = true
    /** Every event for the UI also drives notifications, the unread count and the tray. */
    const send = (e: HushEvent): void => {
      mainWindow?.webContents.send(IPC.event, e)
      if (recoverable && e.type === 'message' && e.message.from === 'me') {
        recoverable = false
        void pushPrivacy()
      }
      if (e.type === 'message' && e.message.from === 'peer') {
        // A message already deleted (arriving through sync) has nothing to announce.
        if (!e.message.deleted) notifier.message({ text: e.message.text, hasImage: !!e.message.image, file: e.message.file?.name, voice: !!e.message.file?.voice, channel: e.message.channel })
        scheduleUnread()
      } else if (e.type === 'status') {
        scheduleUnread()
      } else if (e.type === 'channels') {
        if (e.erased) notifier.dropChannel(e.erased)
        // Creating a channel counts as writing something: recovery is no longer possible.
        if (recoverable && chat.hasOwnMessages()) {
          recoverable = false
          void pushPrivacy()
        }
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
    const chat = new ChatService(db, link, selfId, send, images, { avatars })
    recoverable = !chat.hasOwnMessages()
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
    link.on('down', () => calls.linkDown())
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
        webPreferences
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
      mainWindow.on('hide', () => send({ type: 'hidden' }))
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

      loadRenderer(mainWindow)
      mainWindow.on('closed', () => (mainWindow = null))
    }

    // ---------- IPC (inputs from the renderer are validated here) ----------

    ipcMain.handle(IPC.snapshot, async () => ({
      settings: visible(settings),
      privacy: await privacyState(),
      peer: chat.peerState(),
      channels: chat.listChannels(),
      net: { ...net },
      avatars: avatars.urls(),
      windowActive: userIsLooking(),
      pairing: pairing.state(),
      appVersion: app.getVersion(),
      packaged: app.isPackaged,
      devPairing
    }))

    const updater = new Updater({
      engine: async () => (await import('electron-updater')).default.autoUpdater,
      busy: () => {
        if (calls.openCalls().length > 0) return 'Restarting would end your call.'
        return chat.transfers.busy ? 'A file is still transferring. It will pick up where it stopped after the restart.' : null
      },
      emit: (update) => send({ type: 'update', update })
    })
    // The updater starts the new AppImage straight away, while this copy still holds the
    // single-instance lock, so that copy can give up. This one waits for the lock to be free;
    // whichever gets there second just exits.
    if (process.env.APPIMAGE) nativeUpdater.on('before-quit-for-update', relaunch)
    ipcMain.handle(IPC.updateState, () => updater.state)
    ipcMain.handle(IPC.updateCheck, () => updater.check())
    ipcMain.handle(IPC.updateDownload, () => updater.download())
    ipcMain.handle(IPC.updateInstall, (_e, anyway: unknown) => updater.install(anyway === true))

    ipcMain.handle(IPC.callSignal, (_e, signal: unknown) => {
      // Same validation as frames from the network.
      const frame = parseFrame(JSON.stringify(signal ?? null))
      if (!frame || !isCallSignal(frame)) return false
      calls.fromUs(frame)
      return link.send(frame)
    })

    /** Left out means General; anything else malformed must not quietly land in General. */
    const channelArg = (v: unknown): string => {
      if (v === undefined) return GENERAL_CHANNEL
      if (typeof v !== 'string') throw new Error('Invalid channel')
      return v
    }

    ipcMain.handle(IPC.listMessages, (_e, before?: HistoryCursor, limit?: number, channel?: unknown) => {
      const cursor =
        before && Number.isFinite(before.sentAt) && typeof before.id === 'string' ? { sentAt: before.sentAt, id: before.id } : undefined
      return chat.listMessages(cursor, Number.isInteger(limit) ? (limit as number) : 100, channelArg(channel))
    })

    const optionalId = (v: unknown): string | undefined => {
      if (v === undefined || v === null) return undefined
      if (typeof v !== 'string') throw new Error('Invalid id')
      return v
    }

    ipcMain.handle(IPC.sendMessage, (_e, text: unknown, replyTo: unknown, channel: unknown) => {
      if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new Error('Invalid message')
      return chat.send(text, optionalId(replyTo), channelArg(channel))
    })

    ipcMain.handle(IPC.createChannel, (_e, name: unknown) => {
      if (typeof name !== 'string') throw new Error('Invalid name')
      return chat.createChannel(name)
    })

    ipcMain.handle(IPC.getMessages, (_e, ids: unknown) => {
      if (!Array.isArray(ids) || !ids.every((id) => typeof id === 'string')) return []
      return chat.getMessages(ids as string[])
    })

    ipcMain.handle(IPC.editMessage, (_e, id: unknown, text: unknown) => {
      if (typeof id !== 'string' || typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw new Error('Invalid edit')
      return chat.edit(id, text)
    })

    ipcMain.handle(IPC.deleteMessage, async (_e, id: unknown, mode: unknown) => {
      if (typeof id !== 'string') throw new Error('Invalid id')
      if (mode === 'everyone') await chat.deleteForEveryone(id)
      else if (mode === 'me') chat.deleteForMe(id)
      else throw new Error('Invalid mode')
      scheduleUnread()
    })

    ipcMain.handle(IPC.react, (_e, id: unknown, emoji: unknown, on: unknown) => {
      if (typeof id !== 'string' || typeof emoji !== 'string' || typeof on !== 'boolean') throw new Error('Invalid reaction')
      return chat.react(id, emoji, on)
    })

    ipcMain.handle(IPC.sendFilePath, (_e, path: unknown, caption: unknown, replyTo: unknown, channel: unknown) => {
      if (typeof path !== 'string' || !isAbsolute(path) || typeof caption !== 'string') throw new Error('Invalid file')
      return chat.sendFile(path, caption, optionalId(replyTo), channelArg(channel))
    })

    ipcMain.handle(IPC.sendFileBytes, (_e, bytes: unknown, name: unknown, caption: unknown, replyTo: unknown, voice: unknown, channel: unknown) => {
      if (!(bytes instanceof Uint8Array) || typeof name !== 'string' || typeof caption !== 'string') throw new Error('Invalid file')
      let v: { durationMs: number; peaks: Uint8Array } | undefined
      if (voice !== undefined && voice !== null) {
        const o = voice as { durationMs?: unknown; peaks?: unknown }
        if (typeof o.durationMs !== 'number' || !(o.peaks instanceof Uint8Array)) throw new Error('Invalid voice note')
        v = { durationMs: Math.round(o.durationMs), peaks: o.peaks }
      }
      return chat.sendFileBytes(bytes, name, caption, optionalId(replyTo), v, channelArg(channel))
    })

    ipcMain.on(IPC.downloadFile, (_e, id: unknown) => {
      if (typeof id === 'string') chat.download(id)
    })

    // Saving is the only way an attachment leaves Hush — it's never opened automatically.
    const savedPaths = new Set<string>()
    ipcMain.handle(IPC.saveAttachment, async (_e, id: unknown) => {
      const m = typeof id === 'string' ? db.getMessage(id) : undefined
      if (!m || !blobOf(m) || !mainWindow) return { error: 'Not found' }
      const stamp = new Date(m.sentAt).toISOString().slice(0, 16).replace('T', ' ').replace(':', '-')
      const name = m.file?.name ?? `Hush image ${stamp}.${m.image?.mime.split('/')[1].replace('jpeg', 'jpg') ?? 'png'}`
      if (isRiskyFile(name)) {
        const r = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'This file is a program',
          message: `“${name}” is a program.`,
          detail: `Programs can do anything on your computer. Only save and run it if you expected it from ${chat.peerState().name ?? 'the other person'} and trust it.`,
          buttons: ['Cancel', 'Save anyway'],
          defaultId: 0,
          cancelId: 0
        })
        if (r.response !== 1) return { cancelled: true }
      }
      const r = await dialog.showSaveDialog(mainWindow, { title: 'Save', defaultPath: join(app.getPath('downloads'), name) })
      if (r.canceled || !r.filePath) return { cancelled: true }
      try {
        await chat.exportAttachment(m.id, r.filePath)
        savedPaths.add(r.filePath)
        return { saved: r.filePath }
      } catch (e) {
        return { error: (e as Error).message }
      }
    })

    ipcMain.on(IPC.showInFolder, (_e, path: unknown) => {
      if (typeof path === 'string' && savedPaths.has(path)) shell.showItemInFolder(path)
    })

    ipcMain.handle(IPC.search, (_e, query: unknown) => {
      if (typeof query !== 'string' || query.length > 200) return { results: [], more: false }
      return chat.search(query)
    })

    // Links in messages open in the browser — only http(s), never files or app protocols.
    ipcMain.on(IPC.openLink, (_e, url: unknown) => {
      if (typeof url !== 'string' || url.length > 2048) return
      try {
        const u = new URL(url)
        if (u.protocol === 'http:' || u.protocol === 'https:') void shell.openExternal(u.toString())
      } catch {
        // not a URL
      }
    })

    ipcMain.handle(IPC.sendImage, (_e, img: OutgoingImage, caption: unknown, replyTo: unknown, channel: unknown) => {
      if (!(img?.bytes instanceof Uint8Array) || !(img.thumb instanceof Uint8Array) || typeof caption !== 'string') {
        throw new Error('Invalid image')
      }
      return chat.sendImage(img, caption, optionalId(replyTo), channelArg(channel)) // validates type, signature, size and preview
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

    ipcMain.on(IPC.setTyping, (_e, on: unknown, channel: unknown) => {
      if (typeof on === 'boolean' && (channel === undefined || typeof channel === 'string')) chat.setTyping(on, channel)
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

    // ---------- privacy & data: app password, backups, recovery ----------

    const privacyState = async (): Promise<PrivacyState> => ({
      protection: keyring.mode() === 'password' ? 'password' : 'keychain',
      osName: keyring.osName(),
      osAvailable: await keyring.osAvailable(),
      autoBackup: { ...autoBackup },
      canRecover: recoverable
    })
    async function pushPrivacy(): Promise<void> {
      send({ type: 'privacy', privacy: await privacyState() })
    }
    const okPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 8 && p.length <= 1024

    ipcMain.handle(IPC.setAppPassword, async (_e, password: unknown) => {
      if (password === null) await keyring.protect(dataKey)
      else if (okPassword(password)) await keyring.protect(dataKey, password)
      else throw new Error('Use at least 8 characters.')
      void pushPrivacy()
      return privacyState()
    })

    const backupSource: BackupSource = { snapshotDb: (path) => db.snapshot(path), dataKey, dir: userData, app: app.getVersion() }
    const backupFilters = [{ name: 'Hush backup', extensions: ['hushbackup'] }]

    ipcMain.handle(IPC.backupNow, async (_e, password: unknown, attachments: unknown): Promise<BackupResult> => {
      if (!okPassword(password) || typeof attachments !== 'boolean') return { ok: false, error: 'Use a password of at least 8 characters.' }
      const docs = app.getPath('documents')
      const r = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save Hush backup',
        defaultPath: join(docs, backupFileName(new Date(), docs)),
        filters: backupFilters
      })
      if (r.canceled || !r.filePath) return { ok: false, cancelled: true }
      try {
        const { bytes } = await writeBackup(backupSource, backupKeyFromPassword(password), attachments, r.filePath)
        return { ok: true, path: r.filePath, bytes }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    })

    ipcMain.handle(IPC.restoreBackup, async (_e, password: unknown): Promise<string | null> => {
      if (typeof password !== 'string' || password === '' || password.length > 1024) return 'Enter the backup password.'
      const r = await dialog.showOpenDialog(mainWindow!, { title: 'Restore Hush backup', properties: ['openFile'], filters: backupFilters })
      if (r.canceled || !r.filePaths[0]) return null
      const staging = join(userData, STAGING)
      rmSync(staging, { recursive: true, force: true })
      try {
        const { dataKey: restoredKey } = extractBackup(r.filePaths[0], password, staging)
        // Keep this computer's way of protecting the key; with an app password (or no keychain),
        // the backup password becomes the app password.
        const usePassword = keyring.mode() === 'password' || !(await keyring.osAvailable())
        await new Keyring(staging, osProtector).protect(restoredKey, usePassword ? password : undefined)
        markStagedRestoreReady(userData)
      } catch (e) {
        rmSync(staging, { recursive: true, force: true })
        return (e as Error).message
      }
      relaunch()
      quitApp()
      return null
    })

    // Weekly automatic backups into a folder, keeping the newest three.
    const AUTO_KEY = 'autoBackupKey'
    const WEEK_MS = 7 * 24 * 3600_000
    let autoBackup: AutoBackup = {
      enabled: false,
      folder: join(app.getPath('documents'), 'Hush backups'),
      attachments: false,
      last: null,
      error: null,
      ...db.getSetting<Partial<AutoBackup>>('autoBackup')
    }
    const saveAutoBackup = (patch: Partial<AutoBackup>): void => {
      autoBackup = { ...autoBackup, ...patch }
      if (!closing) db.setSetting('autoBackup', autoBackup) // a backup can end while Hush closes
    }
    let autoRunning = false
    const runAutoBackupIfDue = async (): Promise<void> => {
      if (!autoBackup.enabled || autoRunning || (autoBackup.last && Date.now() - autoBackup.last < WEEK_MS)) return
      const stored = db.getSecret<{ kdf: Parameters<typeof backupKeyFromPassword>[1]; key: string }>(AUTO_KEY)
      if (!stored?.kdf) return
      autoRunning = true
      try {
        mkdirSync(autoBackup.folder, { recursive: true })
        const out = join(autoBackup.folder, backupFileName(new Date(), autoBackup.folder))
        await writeBackup(backupSource, { kdf: stored.kdf, key: Buffer.from(stored.key, 'base64') }, autoBackup.attachments, out)
        pruneBackups(autoBackup.folder, 3)
        saveAutoBackup({ last: Date.now(), error: null })
      } catch (e) {
        saveAutoBackup({ error: (e as Error).message }) // retried within the hour
      } finally {
        autoRunning = false
      }
      void pushPrivacy()
    }
    const firstBackupCheck = setTimeout(() => void runAutoBackupIfDue(), 60_000)
    const backupTimer = setInterval(() => void runAutoBackupIfDue(), 3600_000)

    ipcMain.handle(IPC.setAutoBackup, async (_e, patch: { enabled?: unknown; attachments?: unknown; password?: unknown }) => {
      if (typeof patch?.enabled !== 'boolean') throw new Error('Invalid')
      if (patch.password !== undefined) {
        if (!okPassword(patch.password)) throw new Error('Use a password of at least 8 characters.')
        const bk = backupKeyFromPassword(patch.password)
        db.setSecret(AUTO_KEY, { kdf: bk.kdf, key: bk.key.toString('base64') })
      }
      if (patch.enabled && !db.getSecret(AUTO_KEY)) throw new Error('Choose a backup password first.')
      if (!patch.enabled) db.setSetting(AUTO_KEY, null)
      saveAutoBackup({
        enabled: patch.enabled,
        attachments: typeof patch.attachments === 'boolean' ? patch.attachments : autoBackup.attachments,
        error: null,
        ...(patch.password !== undefined ? { last: null } : {}) // new password: make a fresh backup soon
      })
      void runAutoBackupIfDue()
      return privacyState()
    })

    ipcMain.handle(IPC.chooseBackupFolder, async () => {
      const r = await dialog.showOpenDialog(mainWindow!, {
        title: 'Folder for automatic backups',
        defaultPath: autoBackup.folder,
        properties: ['openDirectory', 'createDirectory']
      })
      if (!r.canceled && r.filePaths[0]) saveAutoBackup({ folder: r.filePaths[0], last: null, error: null })
      void runAutoBackupIfDue()
      return privacyState()
    })

    ipcMain.handle(IPC.recoverHistory, async (): Promise<string | null> => {
      const name = chat.peerState().name ?? 'The other person'
      if (chat.hasOwnMessages()) return 'You already wrote on this computer, so history can’t be recovered here any more.'
      if (!link.peer) return `${name} needs to be online.`
      const previous = await chat.askPreviousId()
      if (!previous) return `${name}’s Hush has no earlier history of yours (or needs an update).`
      // Become the old device again: restart so every part of Hush uses the old id.
      db.setSetting('selfId', previous.id)
      db.setSetting(`seqFloor:${previous.id}`, previous.seq)
      relaunch()
      quitApp()
      return null
    })

    // ---------- screen sharing ----------

    // Which screen or window the next getDisplayMedia() gets (chosen in Hush's own dialog).
    let chosenSource: string | null = null
    session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
        .then((sources) => {
          // On Wayland the system's own prompt has already narrowed this down to the choice.
          const source = chosenSource === null ? sources[0] : sources.find((s) => s.id === chosenSource)
          callback(source ? { video: source } : {})
        })
        .catch(() => callback({}))
    })

    const fakeHelper = env('HUSH_SCREEN_AUDIO_HELPER')
    const helperPath = process.platform === 'win32' ? join(process.resourcesPath, 'hush-audio-capture.exe') : null
    const helperCommand = (pid: number): HelperCommand =>
      fakeHelper
        ? { file: process.execPath, args: [fakeHelper, String(pid)], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } }
        : { file: helperPath!, args: ['--exclude-pid', String(pid)] }
    const windowsAudio = fakeHelper || helperPath ? new WindowsScreenAudio(helperCommand, (pcm) => mainWindow?.webContents.send(IPC.screenPcm, pcm)) : null
    // AppImage's library path would break the system's own tools.
    const run: Run = (cmd, args) =>
      new Promise((resolve, reject) =>
        execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024, timeout: 5000, env: { ...process.env, LD_LIBRARY_PATH: undefined } }, (e, out) => (e ? reject(e) : resolve(out)))
      )
    const linuxAudio = process.platform === 'linux' && !fakeHelper ? new LinuxScreenAudio(run, () => new Set(app.getAppMetrics().map((m) => m.pid))) : null
    void linuxAudio?.removeLeftovers().catch(() => {}) // from a crash during an earlier share

    const screenAudioSupport = async (): Promise<ScreenAudioSupport> => {
      if (windowsAudio) {
        return fakeHelper || existsSync(helperPath!) ? { kind: 'windows' } : { kind: 'none', reason: 'The audio helper is missing from this build.' }
      }
      if (!linuxAudio) return { kind: 'none', reason: 'Not available on this system.' }
      const problem = await linuxAudio.problem()
      return problem ? { kind: 'none', reason: problem } : { kind: 'linux', apps: await linuxAudio.apps().catch(() => []) }
    }

    ipcMain.handle(IPC.shareOptions, async (): Promise<ShareOptions> => {
      // On Wayland apps can't list screens; the system shows its own prompt instead.
      const wayland = process.platform === 'linux' && !!process.env.WAYLAND_DISPLAY
      const sources = wayland ? null : await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } })
      return {
        sources: sources?.map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() })) ?? null,
        audio: await screenAudioSupport()
      }
    })

    ipcMain.handle(IPC.shareChoose, (_e, id: unknown) => {
      chosenSource = typeof id === 'string' ? id : null
    })

    ipcMain.handle(IPC.screenAudioStart, async (_e, target: unknown): Promise<ScreenAudioStarted> => {
      if (typeof target !== 'string' || target.length > 200) return { ok: false, error: 'Invalid choice' }
      try {
        if (windowsAudio) {
          await windowsAudio.start(process.pid)
          return { ok: true, pcm: true }
        }
        if (!linuxAudio) return { ok: false, error: 'Not available on this system.' }
        await linuxAudio.start(target)
        return { ok: true, deviceLabel: SOURCE_LABEL }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    })

    ipcMain.on(IPC.screenAudioStop, () => {
      windowsAudio?.stop()
      void linuxAudio?.stop()
    })

    // ---------- start ----------

    protocol.handle('hush-img', (req) => {
      const url = new URL(req.url)
      const host = url.hostname
      const kind = url.pathname.slice(1)
      const message = host === 'avatar' ? undefined : db.getMessage(host)
      const meta = message ? blobOf(message) : null
      const bytes = host === 'avatar' ? avatars.readForDisplay(kind) : images.readForDisplay(host, kind, meta)
      if (!bytes) return new Response('Not found', { status: 404 })
      const type = kind === 'thumb' ? 'image/webp' : (meta?.mime ?? sniffImage(bytes) ?? 'application/octet-stream')
      return new Response(new Uint8Array(bytes), { headers: { 'content-type': type } })
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

    core = {
      showWindow,
      async shutdown() {
        clearInterval(ipPoll)
        clearInterval(backupTimer)
        clearTimeout(firstBackupCheck)
        windowsAudio?.stop()
        await linuxAudio?.stop()
        for (const id of calls.openCalls()) await link.send({ t: 'call-end', id, reason: 'hangup' })
        await link.stop()
      },
      close() {
        // Nothing may touch the database once it's closed: stop timers that would (the unread
        // recount used to fire after closing and crash with "database connection is not open"),
        // and stop listening to the window.
        closing = true
        clearTimeout(unreadTimer)
        void link.stop() // already stopped, unless shutdown ran out of time: nothing may arrive now
        notifier.dispose()
        chat.dispose()
        pairing.dispose()
        ipcMain.removeAllListeners()
        tray?.destroy()
        db.close()
      }
    }

  }

  // ---------- lifecycle ----------

  app.on('second-instance', () => (core ? core.showWindow() : lockWindow?.focus()))

  app.whenReady().then(async () => {
    if (app.isPackaged) Menu.setApplicationMenu(null)

    // Microphone and screen (calls), notifications, clipboard writes and fullscreen (a shared
    // screen) are the only permissions Hush needs.
    const allowed = new Set(['media', 'display-capture', 'notifications', 'clipboard-sanitized-write', 'fullscreen'])
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => callback(allowed.has(permission)))

    const restored = applyStagedRestore(userData) // a restore chosen last time is swapped in before anything opens
    const keyring = new Keyring(userData, osProtector)
    const key = await obtainKey(keyring)
    startCore(key, keyring, restored)
    lockWindow?.destroy()
  }).catch((e: unknown) => {
    // Without this Hush would keep running with no window and no way to tell why.
    dialog.showErrorBox('Hush couldn’t start', (e as Error).message)
    app.exit(1)
  })

  // Real quit (power button, tray "Quit Hush", Ctrl+Q, or the OS shutting down):
  // hang up any call properly, close the link, and never take longer than a second.
  let shuttingDown = false
  app.on('before-quit', (e) => {
    quitting = true
    if (shuttingDown || !core) return // still locked: nothing to close
    shuttingDown = true
    e.preventDefault()
    const c = core
    void Promise.race([c.shutdown().catch(() => {}), new Promise((r) => setTimeout(r, 1000))]).finally(() => {
      c.close()
      app.exit(0)
    })
  })

  // The window is only hidden, never closed, until a real quit — so don't quit here.
  app.on('window-all-closed', () => {
    if (quitting) app.quit()
  })
}
