import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { MAX_MEMORY_FILE_BYTES } from '../shared/protocol'
import { IPC, type HushApi, type HushEvent } from '../shared/types'

const api: HushApi = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  listMessages: (before, limit, channel) => ipcRenderer.invoke(IPC.listMessages, before, limit, channel),
  sendMessage: (text, replyTo, channel) => ipcRenderer.invoke(IPC.sendMessage, text, replyTo, channel),
  createChannel: (name) => ipcRenderer.invoke(IPC.createChannel, name),
  renameChannel: (id, name) => ipcRenderer.invoke(IPC.renameChannel, id, name),
  deleteChannel: (id) => ipcRenderer.invoke(IPC.deleteChannel, id),
  setChannelMuted: (id, muted) => ipcRenderer.send(IPC.setChannelMuted, id, muted),
  sendImage: (image, caption, replyTo, channel) => ipcRenderer.invoke(IPC.sendImage, image, caption, replyTo, channel),
  getMessages: (ids) => ipcRenderer.invoke(IPC.getMessages, ids),
  editMessage: (id, text) => ipcRenderer.invoke(IPC.editMessage, id, text),
  deleteMessage: (id, mode) => ipcRenderer.invoke(IPC.deleteMessage, id, mode),
  react: (id, emoji, on) => ipcRenderer.invoke(IPC.react, id, emoji, on),
  openLink: (url) => ipcRenderer.send(IPC.openLink, url),
  search: (query) => ipcRenderer.invoke(IPC.search, query),
  shareOptions: () => ipcRenderer.invoke(IPC.shareOptions),
  shareChoose: (sourceId) => ipcRenderer.invoke(IPC.shareChoose, sourceId),
  screenAudioStart: (target) => ipcRenderer.invoke(IPC.screenAudioStart, target),
  screenAudioStop: () => ipcRenderer.send(IPC.screenAudioStop),
  onScreenPcm: (listener) => {
    const handler = (_e: IpcRendererEvent, pcm: Uint8Array): void => listener(pcm)
    ipcRenderer.on(IPC.screenPcm, handler)
    return () => ipcRenderer.removeListener(IPC.screenPcm, handler)
  },
  // The page never handles file paths: only a File the user picked or dropped can be sent, and
  // its path is looked up here. Pasted data has no path and is sent from memory instead.
  sendFile: async (file, caption, replyTo, channel) => {
    const path = webUtils.getPathForFile(file)
    if (path) return ipcRenderer.invoke(IPC.sendFilePath, path, caption, replyTo, channel)
    if (file.size > MAX_MEMORY_FILE_BYTES) throw new Error('Pasted files can be up to 25 MB')
    return ipcRenderer.invoke(IPC.sendFileBytes, new Uint8Array(await file.arrayBuffer()), file.name || 'pasted file', caption, replyTo, undefined, channel)
  },
  sendVoice: (bytes, durationMs, peaks, replyTo, channel) =>
    ipcRenderer.invoke(IPC.sendFileBytes, bytes, 'Voice note.webm', '', replyTo, { durationMs, peaks }, channel),
  downloadFile: (id) => ipcRenderer.send(IPC.downloadFile, id),
  cancelTransfer: (id) => ipcRenderer.send(IPC.cancelTransfer, id),
  saveAttachment: (id) => ipcRenderer.invoke(IPC.saveAttachment, id),
  showInFolder: (path) => ipcRenderer.send(IPC.showInFolder, path),
  retryImage: (id) => ipcRenderer.send(IPC.retryImage, id),
  sendCallSignal: (signal) => ipcRenderer.invoke(IPC.callSignal, signal),
  listCalls: () => ipcRenderer.invoke(IPC.listCalls),
  logCall: (record) => ipcRenderer.send(IPC.logCall, record),
  setAvatar: (bytes) => ipcRenderer.invoke(IPC.setAvatar, bytes),
  quit: () => ipcRenderer.send(IPC.quit),
  submitPairingCode: (code) => ipcRenderer.invoke(IPC.pairSubmit, code),
  forgetPairing: () => ipcRenderer.send(IPC.pairForget),
  markRead: (ids) => ipcRenderer.send(IPC.markRead, ids),
  setTyping: (on, channel) => ipcRenderer.send(IPC.setTyping, on, channel),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  reconnect: () => ipcRenderer.send(IPC.reconnect),
  lockInfo: () => ipcRenderer.invoke(IPC.lockInfo),
  lockSubmit: (password) => ipcRenderer.invoke(IPC.lockSubmit, password),
  setAppPassword: (password) => ipcRenderer.invoke(IPC.setAppPassword, password),
  backupNow: (password, attachments) => ipcRenderer.invoke(IPC.backupNow, password, attachments),
  restoreBackup: (password) => ipcRenderer.invoke(IPC.restoreBackup, password),
  setAutoBackup: (patch) => ipcRenderer.invoke(IPC.setAutoBackup, patch),
  chooseBackupFolder: () => ipcRenderer.invoke(IPC.chooseBackupFolder),
  recoverHistory: () => ipcRenderer.invoke(IPC.recoverHistory),
  updateState: () => ipcRenderer.invoke(IPC.updateState),
  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  installUpdate: (anyway) => ipcRenderer.invoke(IPC.updateInstall, anyway),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: HushEvent): void => listener(event)
    ipcRenderer.on(IPC.event, handler)
    return () => ipcRenderer.removeListener(IPC.event, handler)
  }
}

contextBridge.exposeInMainWorld('hush', api)
