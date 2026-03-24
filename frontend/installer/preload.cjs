const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('installer', {
  install: () => ipcRenderer.invoke('install'),
  launch: (path) => ipcRenderer.invoke('launch', path),
  close: () => ipcRenderer.send('close'),
});
