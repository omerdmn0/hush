import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import { MAX_MEMORY_FILE_BYTES } from '../shared/protocol'
import { IPC, type HushApi, type HushEvent } from '../shared/types'

const api: HushApi = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  listMessages: (before, limit) => ipcRenderer.invoke(IPC.listMessages, before, limit),
  sendMessage: (text, replyTo) => ipcRenderer.invoke(IPC.sendMessage, text, replyTo),
  sendImage: (image, caption, replyTo) => ipcRenderer.invoke(IPC.sendImage, image, caption, replyTo),
  getMessages: (ids) => ipcRenderer.invoke(IPC.getMessages, ids),
  editMessage: (id, text) => ipcRenderer.invoke(IPC.editMessage, id, text),
  deleteMessage: (id, mode) => ipcRenderer.invoke(IPC.deleteMessage, id, mode),
  react: (id, emoji, on) => ipcRenderer.invoke(IPC.react, id, emoji, on),
  openLink: (url) => ipcRenderer.send(IPC.openLink, url),
  search: (query) => ipcRenderer.invoke(IPC.search, query),
  // The page never handles file paths: only a File the user picked or dropped can be sent, and
  // its path is looked up here. Pasted data has no path and is sent from memory instead.
  sendFile: async (file, caption, replyTo) => {
    const path = webUtils.getPathForFile(file)
    if (path) return ipcRenderer.invoke(IPC.sendFilePath, path, caption, replyTo)
    if (file.size > MAX_MEMORY_FILE_BYTES) throw new Error('Pasted files can be up to 25 MB')
    return ipcRenderer.invoke(IPC.sendFileBytes, new Uint8Array(await file.arrayBuffer()), file.name || 'pasted file', caption, replyTo)
  },
  sendVoice: (bytes, durationMs, peaks, replyTo) =>
    ipcRenderer.invoke(IPC.sendFileBytes, bytes, 'Voice note.webm', '', replyTo, { durationMs, peaks }),
  downloadFile: (id) => ipcRenderer.send(IPC.downloadFile, id),
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
  setTyping: (on) => ipcRenderer.send(IPC.setTyping, on),
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
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: HushEvent): void => listener(event)
    ipcRenderer.on(IPC.event, handler)
    return () => ipcRenderer.removeListener(IPC.event, handler)
  }
}

contextBridge.exposeInMainWorld('hush', api)
