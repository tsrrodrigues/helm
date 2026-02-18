const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('helm', {
  resizeWindow: (height) => ipcRenderer.send('resize-window', height),
  navigateToPane: (sessionName, windowName, paneId, weztermTabId) =>
    ipcRenderer.send('navigate-to-pane', sessionName, windowName, paneId, weztermTabId),
  confirmName: (sessionName, name) => ipcRenderer.send('confirm-name', sessionName, name),
  setIgnoreMouse: (ignore) => ipcRenderer.sendSync('set-ignore-mouse', ignore),
  saveFrontOrder: (order) => ipcRenderer.send('save-front-order', order),
  getFrontOrder: () => ipcRenderer.invoke('get-front-order'),
  onShortcutFired: (cb) => ipcRenderer.on('shortcut-fired', cb),
  onStateUpdate: (cb) => ipcRenderer.on('state-update', (_event, state) => cb(state)),
  onActiveApp: (cb) => ipcRenderer.on('active-app-changed', (_event, info) => cb(info)),
  getState: () => ipcRenderer.invoke('get-state')
});
