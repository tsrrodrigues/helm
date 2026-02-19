const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helm', {
  getLayout: () => ipcRenderer.sendSync('get-layout'),
  recalculateBounds: () => ipcRenderer.sendSync('recalculate-bounds'),
  navigateToPane: (sessionName, windowName, paneId, weztermTabId) =>
    ipcRenderer.send('navigate-to-pane', sessionName, windowName, paneId, weztermTabId),
  confirmName: (sessionName, name) => ipcRenderer.send('confirm-name', sessionName, name),
  setIgnoreMouse: (ignore) => ipcRenderer.sendSync('set-ignore-mouse', ignore),
  saveFrontOrder: (order) => ipcRenderer.send('save-front-order', order),
  getFrontOrder: () => ipcRenderer.invoke('get-front-order'),
  moveWindow: (dx, dy) => ipcRenderer.send('move-window', dx, dy),
  savePillPosition: (x, y) => ipcRenderer.send('save-pill-position', x, y),
  getPillPosition: () => ipcRenderer.invoke('get-pill-position'),
  onShortcutFired: (cb) => ipcRenderer.on('shortcut-fired', cb),
  onStateUpdate: (cb) => ipcRenderer.on('state-update', (_event, state) => cb(state)),
  refocusPreviousApp: () => ipcRenderer.send('refocus-previous-app'),
  blurWindow: () => ipcRenderer.send('blur-window'),
  onActiveApp: (cb) => ipcRenderer.on('active-app-changed', (_event, info) => cb(info)),
  getState: () => ipcRenderer.invoke('get-state'),
  createSession: (name) => ipcRenderer.invoke('create-session', name),
  createWindow: (sessionName) => ipcRenderer.invoke('create-window', sessionName),
  killSession: (sessionName) => ipcRenderer.invoke('kill-session', sessionName),
  killWindow: (paneId) => ipcRenderer.invoke('kill-window', paneId),
  renameAgent: (paneId) => ipcRenderer.invoke('rename-agent', paneId)
});
