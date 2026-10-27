import { contextBridge, ipcRenderer } from 'electron';

console.log('=== PRELOAD SCRIPT LOADING ===');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // Agent control
  startAgent: () => ipcRenderer.invoke('start-agent'),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  getAgentStatus: () => ipcRenderer.invoke('get-agent-status'),
  getProcessRegistry: () => ipcRenderer.invoke('get-process-registry'),
  getAgentLogs: (lines?: number) => ipcRenderer.invoke('get-agent-logs', lines),
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (config: unknown) => ipcRenderer.invoke('save-config', config),
  lookupAsset: (request: { assetTag: string; apiUrl?: string; apiKey?: string }) => ipcRenderer.invoke('lookup-asset', request),

  // YARA scanner plugin
  yaraPluginStatus: () => ipcRenderer.invoke('yara-plugin-status'),
  yaraPluginInstall: () => ipcRenderer.invoke('yara-plugin-install'),
  yaraPluginUninstall: () => ipcRenderer.invoke('yara-plugin-uninstall'),

  // System info
  getSystemInfo: () => ipcRenderer.invoke('get-system-info'),

  // App/update info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  checkForUpdate: () => ipcRenderer.invoke('check-for-update'),
  downloadAndInstallUpdate: () => ipcRenderer.invoke('download-and-install-update'),

  // Background start. Deliberately narrower than the whole config, which
  // carries the API key and has no business in the renderer.
  getAutoStart: () => ipcRenderer.invoke('get-auto-start'),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke('set-auto-start', enabled),

  // File operations
  openConfig: () => ipcRenderer.invoke('open-config'),
  openLogs: () => ipcRenderer.invoke('open-logs'),

  // Novaris user session. The JWT stays in the main process; only the profile reaches the renderer.
  userSessionStatus: () => ipcRenderer.invoke('user-session-status'),
  userLogin: (email: string, password: string) => ipcRenderer.invoke('user-login', email, password),
  userLogout: () => ipcRenderer.invoke('user-logout'),
  userChangePassword: (currentPassword: string, newPassword: string, confirmation: string) =>
    ipcRenderer.invoke('user-change-password', currentPassword, newPassword, confirmation),
  onUserSessionChanged: (callback: (event: any, data: any) => void) =>
    ipcRenderer.on('user-session-changed', callback),

  // Self-service helpdesk as the signed-in user. Results are { success, data } or { success: false, message }.
  helpdeskListTickets: (status?: string) => ipcRenderer.invoke('helpdesk-list-tickets', status),
  helpdeskCreateTicket: (ticket: unknown) => ipcRenderer.invoke('helpdesk-create-ticket', ticket),
  helpdeskAssetCategories: () => ipcRenderer.invoke('helpdesk-asset-categories'),
  helpdeskRequestAsset: (request: unknown) => ipcRenderer.invoke('helpdesk-request-asset', request),
  helpdeskAccessSystems: () => ipcRenderer.invoke('helpdesk-access-systems'),
  helpdeskRequestAccess: (request: unknown) => ipcRenderer.invoke('helpdesk-request-access', request),

  // Local AI assistant. The user's JWT and the runtime port/token never reach the renderer.
  agentRuntimeStatus: () => ipcRenderer.invoke('agent-runtime-status'),

  // Assistant chat transport. Events are the runtime's protocol payloads.
  agentChatConnect: () => ipcRenderer.invoke('agent-chat-connect'),
  agentChatCreateSession: () => ipcRenderer.invoke('agent-chat-session-create'),
  agentChatSend: (text: string) => ipcRenderer.invoke('agent-chat-send', text),
  agentChatRespond: (type: 'approval' | 'clarify', value: string, requestId?: string, sessionId?: string) =>
    ipcRenderer.invoke('agent-chat-respond', type, value, requestId, sessionId),
  agentChatDisconnect: () => ipcRenderer.invoke('agent-chat-disconnect'),
  onAgentChatEvent: (callback: (event: any, data: any) => void) => {
    ipcRenderer.send('agent-chat-listen');
    return ipcRenderer.on('agent-chat-event', callback);
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