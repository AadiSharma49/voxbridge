const { contextBridge, ipcRenderer } = require('electron');

// Expose a tiny safe API to the renderer instead of enabling Node integration there.
contextBridge.exposeInMainWorld('desktopApp', {
  getVersion: () => ipcRenderer.invoke('app:get-version'),
  getTranslationLanguages: (payload) => ipcRenderer.invoke('translation:get-languages', payload),
  translateText: (payload) => ipcRenderer.invoke('translation:request', payload),
  getAudioCapabilities: () => ipcRenderer.invoke('audio:get-capabilities'),
  checkModelAvailability: (langCode) => ipcRenderer.invoke('models:check-availability', langCode),
  getModelPath: (langCode) => ipcRenderer.invoke('models:get-path', langCode),
  setOverlayState: (state) => ipcRenderer.invoke('overlay:set-state', state),
  quitApp: () => ipcRenderer.invoke('app:quit'),
  minimizeWindow: () => ipcRenderer.invoke('window:minimize'),
  onOverlayShortcut: (callback) => {
    const listener = (_, command) => callback(command);
    ipcRenderer.on('overlay:shortcut', listener);
    return () => ipcRenderer.removeListener('overlay:shortcut', listener);
  }
});
