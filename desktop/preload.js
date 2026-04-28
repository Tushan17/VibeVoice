'use strict'

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('vibeAPI', {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (s) => ipcRenderer.invoke('save-settings', s),

  // Server
  getServerStatus: () => ipcRenderer.invoke('get-server-status'),
  startServer: (settings) => ipcRenderer.invoke('start-server', settings),
  stopServer: () => ipcRenderer.invoke('stop-server'),

  // Native dialogs
  browseFolder: () => ipcRenderer.invoke('browse-folder'),
  browsePython: () => ipcRenderer.invoke('browse-python'),

  // Events (main → renderer)
  onServerLog: (cb) => ipcRenderer.on('server-log', (_e, msg) => cb(msg)),
  onServerStatus: (cb) => ipcRenderer.on('server-status', (_e, status) => cb(status)),
})
