// preload.js — safe IPC bridge. contextIsolation is ON; we expose only a narrow API.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getPaths: () => ipcRenderer.invoke('get-paths'),
  listResumeMaps: () => ipcRenderer.invoke('list-resume-maps'),
  listRosters: () => ipcRenderer.invoke('list-rosters'),
  listTabs: () => ipcRenderer.invoke('list-tabs'),
  runCommand: (payload) => ipcRenderer.invoke('run-command', payload),
  killCommand: () => ipcRenderer.invoke('kill-command'),

  // Streaming callbacks. Return an unsubscribe fn.
  onOutput: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('run-output', listener);
    return () => ipcRenderer.removeListener('run-output', listener);
  },
  onExit: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('run-exit', listener);
    return () => ipcRenderer.removeListener('run-exit', listener);
  }
});
