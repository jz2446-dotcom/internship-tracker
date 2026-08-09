// preload.js — safe IPC bridge. contextIsolation is ON; only this narrow API is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  getPlan: (opts) => ipcRenderer.invoke('get-plan', opts),
  startRun: (opts) => ipcRenderer.invoke('start-run', opts),
  stopRun: () => ipcRenderer.invoke('stop-run'),

  onOutput: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('run-output', l);
    return () => ipcRenderer.removeListener('run-output', l);
  },
  onPlan: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('plan', l);
    return () => ipcRenderer.removeListener('plan', l);
  },
  onStepStatus: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('step-status', l);
    return () => ipcRenderer.removeListener('step-status', l);
  },
  onDone: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('run-done', l);
    return () => ipcRenderer.removeListener('run-done', l);
  },

  // --- Debug browser (BrowserView, positioned by the renderer's own layout) ---
  browserNavigate: (url) => ipcRenderer.invoke('browser-navigate', url),
  browserBack: () => ipcRenderer.invoke('browser-back'),
  browserForward: () => ipcRenderer.invoke('browser-forward'),
  browserReload: () => ipcRenderer.invoke('browser-reload'),
  browserDevtools: () => ipcRenderer.invoke('browser-devtools'),
  browserSetBounds: (bounds) => ipcRenderer.invoke('browser-set-bounds', bounds),
  browserSetVisible: (visible) => ipcRenderer.invoke('browser-set-visible', visible),
  onBrowserNavState: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('browser-nav-state', l);
    return () => ipcRenderer.removeListener('browser-nav-state', l);
  },
});
