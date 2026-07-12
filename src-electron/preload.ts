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

  // Hermes bootstrap (detects existing local Hermes installs and skips
  // the managed install flow when one is already present)
  hermesBootstrap: (installCode: string) => ipcRenderer.invoke('hermes-bootstrap', installCode),

  // Hermes gateway management. Secrets are redacted by the main process.
  hermesGatewayGetConfig: () => ipcRenderer.invoke('hermes-gateway-get-config'),
  hermesGatewaySaveConfig: (config: unknown) => ipcRenderer.invoke('hermes-gateway-save-config', config),
  hermesGatewayStatus: () => ipcRenderer.invoke('hermes-gateway-status'),
  hermesGatewayStart: () => ipcRenderer.invoke('hermes-gateway-start'),
  hermesGatewayStop: () => ipcRenderer.invoke('hermes-gateway-stop'),
  hermesGatewayRestart: () => ipcRenderer.invoke('hermes-gateway-restart'),
  hermesPairingList: () => ipcRenderer.invoke('hermes-pairing-list'),
  hermesPairingPending: () => ipcRenderer.invoke('hermes-pairing-pending'),
  hermesPairingApprove: (platform: string, code: string) => ipcRenderer.invoke('hermes-pairing-approve', platform, code),
  hermesPairingRevoke: (platform: string, userId: string) => ipcRenderer.invoke('hermes-pairing-revoke', platform, userId),

  // Hermes local gateway chat transport. Events are emitted as sanitized protocol payloads.
  hermesChatConnect: (port?: number, token?: string) => ipcRenderer.invoke('hermes-chat-connect', port, token),
  hermesChatCreateSession: () => ipcRenderer.invoke('hermes-chat-session-create'),
  hermesChatSend: (text: string) => ipcRenderer.invoke('hermes-chat-send', text),
  hermesChatRespond: (type: 'approval' | 'secret' | 'sudo' | 'clarify', value: string, requestId?: string, sessionId?: string) =>
    ipcRenderer.invoke('hermes-chat-respond', type, value, requestId, sessionId),
  hermesChatDisconnect: () => ipcRenderer.invoke('hermes-chat-disconnect'),
  onHermesChatEvent: (callback: (event: any, data: any) => void) => {
    ipcRenderer.send('hermes-chat-listen');
    return ipcRenderer.on('hermes-chat-event', callback);
  },

  // Event listeners
  onAgentStatusChanged: (callback: (event: any, data: any) => void) =>
    ipcRenderer.on('agent-status-changed', callback),

  onUpdateDownloadProgress: (callback: (event: any, data: any) => void) =>
    ipcRenderer.on('update-download-progress', callback),

  removeAllListeners: (event: string) =>
    ipcRenderer.removeAllListeners(event)
});

console.log('=== PRELOAD SCRIPT LOADED, electronAPI EXPOSED ===');