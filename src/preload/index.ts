import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IPC, type HushApi, type HushEvent } from '../shared/types'

const api: HushApi = {
  platform: process.platform,
  getSnapshot: () => ipcRenderer.invoke(IPC.snapshot),
  listMessages: (before, limit) => ipcRenderer.invoke(IPC.listMessages, before, limit),
  sendMessage: (text) => ipcRenderer.invoke(IPC.sendMessage, text),
  sendImage: (image, caption) => ipcRenderer.invoke(IPC.sendImage, image, caption),
  retryImage: (id) => ipcRenderer.send(IPC.retryImage, id),
  sendCallSignal: (signal) => ipcRenderer.invoke(IPC.callSignal, signal),
  listCalls: () => ipcRenderer.invoke(IPC.listCalls),
  logCall: (record) => ipcRenderer.send(IPC.logCall, record),
  setAvatar: (bytes) => ipcRenderer.invoke(IPC.setAvatar, bytes),
  quit: () => ipcRenderer.send(IPC.quit),
  markRead: (ids) => ipcRenderer.send(IPC.markRead, ids),
  setTyping: (on) => ipcRenderer.send(IPC.setTyping, on),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.updateSettings, patch),
  reconnect: () => ipcRenderer.send(IPC.reconnect),
  onEvent: (listener) => {
    const handler = (_e: IpcRendererEvent, event: HushEvent): void => listener(event)
    ipcRenderer.on(IPC.event, handler)
    return () => ipcRenderer.removeListener(IPC.event, handler)
  }
}

contextBridge.exposeInMainWorld('hush', api)
