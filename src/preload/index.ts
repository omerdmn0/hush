import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
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
