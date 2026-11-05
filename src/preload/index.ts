import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type HushApi } from '../shared/types'

const api: HushApi = {
  platform: process.platform,
  getTailscaleIp: () => ipcRenderer.invoke(IPC.tailscaleIp)
}

contextBridge.exposeInMainWorld('hush', api)
