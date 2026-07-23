const { contextBridge, ipcRenderer } = require('electron');

// Expose a tiny safe API to the renderer instead of enabling Node integration there.
contextBridge.exposeInMainWorld('desktopApp', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  translate: (payload) => ipcRenderer.invoke('translation:translate', payload),
  getAudioCapabilities: () => ipcRenderer.invoke('audio:get-capabilities'),
  setOverlayState: (state) => ipcRenderer.invoke('overlay:set-state', state),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  onOverlayShortcut: (callback) => {
    const listener = (_, command) => callback(command);
    ipcRenderer.on('overlay:shortcut', listener);
    return () => ipcRenderer.removeListener('overlay:shortcut', listener);
  }
});
