import { contextBridge, ipcRenderer } from 'electron';

console.log('=== PRELOAD SCRIPT LOADING ===');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Agent control
  startAgent: () => ipcRenderer.invoke('start-agent'),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  getAgentStatus: () => ipcRenderer.invoke('get-agent-status'),

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // App/update info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('download-and-install-update'),

  // File operations
  openConfig: () => ipcRenderer.invoke('open-config'),
  openLogs: () => ipcRenderer.invoke('open-logs'),

  // Event listeners
  onAgentStatusChanged: (callback: (event: any, data: any) => void) =>
    ipcRenderer.on('agent-status-changed', callback),

  onUpdateDownloadProgress: (callback: (event: any, data: any) => void) =>
    ipcRenderer.on('update-download-progress', callback),

  removeAllListeners: (event: string) =>
    ipcRenderer.removeAllListeners(event)
});

console.log('=== PRELOAD SCRIPT LOADED, electronAPI EXPOSED ===');