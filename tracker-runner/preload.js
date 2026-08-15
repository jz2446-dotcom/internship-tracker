// preload.js — safe IPC bridge. contextIsolation is ON; only this narrow API is exposed.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getInfo: () => ipcRenderer.invoke('get-info'),
  getPlan: (opts) => ipcRenderer.invoke('get-plan', opts),
  startRun: (opts) => ipcRenderer.invoke('start-run', opts),
  startDedup: () => ipcRenderer.invoke('start-dedup'),
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

  // --- History panel (calendar-selected snapshot, same BrowserView pattern) ---
  listHistoryDates: () => ipcRenderer.invoke('list-history-dates'),
  viewHistory: (date) => ipcRenderer.invoke('view-history', date),
  historySetBounds: (bounds) => ipcRenderer.invoke('history-set-bounds', bounds),
  historySetVisible: (visible) => ipcRenderer.invoke('history-set-visible', visible),
  onHistoryNavState: (cb) => {
    const l = (_e, d) => cb(d);
    ipcRenderer.on('history-nav-state', l);
    return () => ipcRenderer.removeListener('history-nav-state', l);
  },
});
