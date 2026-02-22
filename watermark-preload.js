const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wmBridge', {
  onUpdate: (cb) => ipcRenderer.on('watermark-update', (_event, data) => cb(data))
});
