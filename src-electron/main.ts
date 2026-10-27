import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import { AgentService } from '../dist/services/agentService';
import { loadConfig, readConfig, saveConfig, getInstallDirectory } from '../dist/utils/config';
import { AgentConfig, DEFAULT_CONFIG } from '../dist/types/config';
import { createLogger } from '../dist/utils/logger';
import { DeviceInfoCollector } from '../dist/collectors/deviceInfoCollector';
import { HealthMetricsCollector } from '../dist/collectors/healthMetricsCollector';
import { AgentRuntimeManager } from './agentRuntime/agentRuntimeManager';
import { AgentRuntimeSupervisor } from './agentRuntime/supervisor';
import { AgentChatResponseType, AgentChatService } from './agentRuntime/chatService';
import { EncryptedFileStore } from './userSession/encryptedFileStore';
import { UserSessionService } from './userSession/userSessionService';
import { HelpdeskService } from './helpdesk/helpdeskService';
import { ProcessRegistryService } from '../dist/services/processRegistryService';
import { YaraPluginService } from '../dist/services/yaraPluginService';
import { AutoStartService } from './startup/autoStartService';
import { BackgroundServiceDetector, BackgroundServiceStatus } from './startup/backgroundServiceDetector';

// The logger must be initialized before anything else in this module: the
// services constructed below resolve it eagerly and cannot be built without it.
let initialConfig: AgentConfig;
try {
  initialConfig = loadConfig();
} catch (error) {
  console.warn('Config validation failed, using defaults', error);
  initialConfig = { ...DEFAULT_CONFIG } as AgentConfig;
}
const logger = createLogger(initialConfig);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentService: AgentService | null = null;
let isAgentRunning = false;
let isQuitting = false;
// The Novaris user signed in on this device. Their JWT stays in the main process.
const userSession = new UserSessionService(
  new EncryptedFileStore(path.join(app.getPath('userData'), 'user-session', 'session.bin')),
  () => {
    try {
      return loadConfig().apiUrl;
    } catch {
      return undefined;
    }
  }
);
// The local AI assistant (LangChain Deep Agents runtime, bundled under resources/agent-runtime).
// It runs as the signed-in user, so signing out or switching user stops it.
const agentRuntimeDir = path.join(app.getPath('userData'), 'agent-runtime');
const agentRuntime = new AgentRuntimeManager({
  runtimeDir: agentRuntimeDir,
  supervisor: new AgentRuntimeSupervisor({
    resourcesPath: process.resourcesPath,
    runtimeDir: agentRuntimeDir,
    isPackaged: app.isPackaged,
    devRuntimeDir: path.join(__dirname, '..', 'runtime'),
  }),
  userSession,
});
const agentChatService = new AgentChatService(() => agentRuntime.endpoint());
// Tickets, access requests and asset requests filed as the signed-in user.
const helpdesk = new HelpdeskService(userSession);
let assistantUserId: number | null = null;
userSession.onChange((status) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('user-session-changed', status);
  }
  const userId = status.user?.id ?? null;
  if (userId !== assistantUserId) {
    assistantUserId = userId;
    agentChatService.disconnect();
    agentRuntime.reset().catch((error) => logger.error('Failed to stop the assistant', { error: error.message }));
  } else {
    agentRuntime.refreshAccessToken().catch((error) => logger.warn('Failed to update the assistant token', { error: error.message }));
  }
});
const processRegistry = new ProcessRegistryService(initialConfig.logFile);
processRegistry.registerDefaults(initialConfig);
const autoStartService = new AutoStartService();
const backgroundServiceDetector = new BackgroundServiceDetector();

/**
 * Set while the headless service installed by the platform installers is the
 * one reporting for this device. The desktop agent then stays idle rather than
 * doubling every metric the backend receives for the same asset tag.
 */
let backgroundService: BackgroundServiceStatus | null = null;

/**
 * True when the OS launched us at login rather than a person. Such a launch
 * stays in the tray and never raises a dialog, since nobody is watching.
 */
const launchedInBackground = autoStartService.wasLaunchedInBackground();

// Only one instance may own the agent runtime. Without this, a login-launched
// instance plus a manual launch would both report for the same asset tag.
const hasSingleInstanceLock = app.requestSingleInstanceLock();

interface AgentUpdateInfo {
  version: string;
  downloadUrl: string;
  releaseNotes: string | null;
  osType: 'windows' | 'mac' | 'linux';
  arch: string | null;
  artifactType: string | null;
  releasedAt: string;
}

let cachedUpdateInfo: AgentUpdateInfo | null = null;

function getCurrentVersion(): string {
  const runtimeVersion = app.getVersion();

  if (app.isPackaged) {
    return runtimeVersion;
  }

  const candidatePackagePaths = [
    path.resolve(__dirname, '../package.json'),
    path.resolve(process.cwd(), 'package.json'),
  ];

  for (const packagePath of candidatePackagePaths) {
    try {
      if (!fs.existsSync(packagePath)) {
        continue;
      }

      const pkg = JSON.parse(fs.readFileSync(packagePath, 'utf-8'));
      if (typeof pkg.version === 'string' && pkg.version.trim().length > 0) {
        return pkg.version;
      }
    } catch (_error) {
      // Try next candidate path
    }
  }

  return runtimeVersion;
}

function getOsType(): 'windows' | 'mac' | 'linux' {
  if (process.platform === 'win32') {
    return 'windows';
  }

  if (process.platform === 'darwin') {
    return 'mac';
  }

  return 'linux';
}

function compareSemver(a: string, b: string): number {
  const normalize = (value: string) => {
    const [core] = value.split('-');
    return core
      .split('.')
      .map((part) => parseInt(part, 10))
      .map((part) => (Number.isNaN(part) ? 0 : part));
  };

  const aParts = normalize(a);
  const bParts = normalize(b);
  const maxLen = Math.max(aParts.length, bParts.length);

  for (let index = 0; index < maxLen; index += 1) {
    const aPart = aParts[index] || 0;
    const bPart = bParts[index] || 0;

    if (aPart > bPart) {
      return 1;
    }

    if (aPart < bPart) {
      return -1;
    }
  }

  return 0;
}

async function fetchLatestRelease(): Promise<AgentUpdateInfo | null> {
  let config: AgentConfig;

  try {
    config = loadConfig();
  } catch (error: any) {
    throw new Error(`Failed to load config for update check: ${error.message}`);
  }

  if (!config.apiUrl || !config.apiKey) {
    throw new Error('apiUrl and apiKey are required to check updates');
  }

  let response;

  try {
    response = await axios.get(`${config.apiUrl}/agent-releases/latest-agent`, {
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
      params: {
        os_type: getOsType(),
        arch: process.arch,
      },
      timeout: 30000,
    });
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return null;
    }

    throw error;
  }

  const payload = response.data?.data;
  if (!payload) {
    return null;
  }

  return {
    version: payload.version,
    downloadUrl: payload.download_url,
    releaseNotes: payload.release_notes || null,
    osType: payload.os_type,
    arch: payload.arch || null,
    artifactType: payload.artifact_type || null,
    releasedAt: payload.released_at,
  };
}

async function checkForUpdate() {
  const latest = await fetchLatestRelease();
  if (!latest) {
    cachedUpdateInfo = null;
    return {
      updateAvailable: false,
      currentVersion: getCurrentVersion(),
      latestVersion: null,
      updateInfo: null,
      message: 'No release metadata available for this platform',
    };
  }

  const currentVersion = getCurrentVersion();
  const isNewer = compareSemver(latest.version, currentVersion) > 0;

  cachedUpdateInfo = isNewer ? latest : null;

  return {
    updateAvailable: isNewer,
    currentVersion,
    latestVersion: latest.version,
    updateInfo: latest,
    message: isNewer ? 'Update available' : 'You are using the latest version',
  };
}

async function downloadAndInstallUpdate() {
  if (!cachedUpdateInfo) {
    const checkResult = await checkForUpdate();
    if (!checkResult.updateAvailable || !checkResult.updateInfo) {
      return {
        success: false,
        message: checkResult.message,
      };
    }
  }

  const target = cachedUpdateInfo as AgentUpdateInfo;
  const updatesDir = path.join(app.getPath('downloads'), 'NovarisAgentUpdates');
  fs.mkdirSync(updatesDir, { recursive: true });

  const parsedUrl = new URL(target.downloadUrl);
  const candidateName = path.basename(parsedUrl.pathname);
  const fallbackExt = getOsType() === 'windows' ? 'msi' : getOsType() === 'mac' ? 'dmg' : 'AppImage';
  const fileName = candidateName && candidateName !== '/' ? candidateName : `novaris-agent-${target.version}.${fallbackExt}`;
  const filePath = path.join(updatesDir, fileName);

  const response = await axios.get(target.downloadUrl, {
    responseType: 'stream',
    timeout: 0,
  });

  const totalBytes = Number(response.headers['content-length'] || 0);
  let downloadedBytes = 0;

  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(filePath);

    response.data.on('data', (chunk: Buffer) => {
      downloadedBytes += chunk.length;
      if (mainWindow && totalBytes > 0) {
        mainWindow.webContents.send('update-download-progress', {
          percent: Math.min(100, Math.round((downloadedBytes / totalBytes) * 100)),
        });
      }
    });

    response.data.on('error', reject);
    writer.on('error', reject);
    writer.on('finish', resolve);

    response.data.pipe(writer);
  });

  if (getOsType() !== 'windows') {
    try {
      fs.chmodSync(filePath, 0o755);
    } catch (_error) {
      // no-op; installer may still be opened successfully without chmod depending on platform/artifact
    }
  }

  const openResult = await shell.openPath(filePath);
  if (openResult) {
    throw new Error(`Failed to open installer: ${openResult}`);
  }

  dialog.showMessageBox({
    type: 'info',
    title: 'Installer Opened',
    message: 'Update installer has been opened',
    detail: 'Follow the installer steps to complete update. You can close Novaris Agent once installation starts.',
  });

  return {
    success: true,
    message: 'Update downloaded and installer opened',
    filePath,
    version: target.version,
  };
}

/** Brings the existing window forward, recreating it if it was disposed. */
function revealMainWindow(): void {
  if (mainWindow) {
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  createWindow();
}

function createWindow(options: { startHidden?: boolean } = {}): void {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: (() => {
        const preloadPath = path.join(__dirname, 'preload.js');
        console.log('Preload path:', preloadPath);
        console.log('Preload file exists:', fs.existsSync(preloadPath));
        return preloadPath;
      })()
    },
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: 'Novaris Agent',
    icon: process.env.NODE_ENV === 'development'
      ? path.join(__dirname, '../src-electron/assets/app_icon.png')
      : path.join(__dirname, 'assets/app_icon.png'),
    show: false // Revealed on ready-to-show, unless launched in the background
  });

  // Load the UI
  const uiPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '../src-electron/ui/index.html')
    : path.join(__dirname, 'ui/index.html');

  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('__dirname:', __dirname);
  console.log('UI Path:', uiPath);
  console.log('UI file exists:', fs.existsSync(uiPath));

  try {
    console.log('Attempting to load UI from:', uiPath);
    
    // Disable cache in development
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.session.clearCache();
    }
    
    mainWindow.loadFile(uiPath);
    console.log('UI loaded successfully');
    
    // Open DevTools in development mode
    if (process.env.NODE_ENV === 'development') {
      mainWindow.webContents.openDevTools();
    }
  } catch (error) {
    console.error('Failed to load UI:', error);
    // Fallback: load a simple HTML string
    mainWindow.loadURL(`data:text/html,
      <html>
        <body>
          <h1>Novaris Agent</h1>
          <p>UI failed to load. Check console for errors.</p>
          <p>UI Path: ${uiPath}</p>
          <p>File exists: ${fs.existsSync(uiPath)}</p>
        </body>
      </html>
    `);
  }

  // Hide menu bar by default
  mainWindow.setMenuBarVisibility(false);

  // Handle Alt key press to toggle menu bar
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'Alt' && input.type === 'keyDown') {
      const currentVisibility = mainWindow?.isMenuBarVisible();
      mainWindow?.setMenuBarVisibility(!currentVisibility);
    }
  });

  // Log when window is ready
  mainWindow.once('ready-to-show', () => {
    console.log('Window ready to show');

    // A background launch keeps the window loaded but off screen, so the tray
    // and the agent are live without interrupting whoever just logged in.
    if (options.startHidden) {
      logger.info('Launched in background, staying in the tray');
      return;
    }

    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // Hide window to tray instead of closing it (only if tray exists)
  mainWindow.on('close', (event) => {
    if (mainWindow && tray && !isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Hide window to tray when minimized
  mainWindow.on('minimize', (event: Electron.Event) => {
    if (mainWindow && tray) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Dereference window when closed
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** Builds the tray menu and tooltip from the current agent status. */
function buildTrayMenu(): { menu: Menu; tooltip: string } {
  const status = buildAgentStatus();

  const menu = Menu.buildFromTemplate([
    {
      label: 'Show Novaris Agent',
      click: () => revealMainWindow()
    },
    { type: 'separator' },
    {
      label: `Status: ${status.status}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Start Agent',
      click: () => startAgent(),
      // The service owns reporting; starting here would double every metric
      enabled: !status.running && !status.managedByService
    },
    {
      label: 'Stop Agent',
      click: () => stopAgent(),
      enabled: status.running
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  return { menu, tooltip: `Novaris Agent - ${status.status}` };
}

function createTray(): void {
  // Create tray icon
  const iconPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '../src-electron/assets/favicon.png')
    : path.join(__dirname, 'assets/favicon.png');

  try {
    tray = new Tray(iconPath);

    const { menu, tooltip } = buildTrayMenu();
    tray.setToolTip(tooltip);
    tray.setContextMenu(menu);

    // Double-click tray icon to show window
    tray.on('double-click', () => revealMainWindow());
  } catch (error) {
    logger.warn('Failed to create tray icon, skipping tray functionality', { error });
    // Continue without tray
  }
}

/**
 * Turns background start on the first time this device proves to be fully
 * configured, which is the first time the agent actually starts. This covers
 * every way a config can arrive - the installer, a hand-edited config.json or
 * the UI - and stops as soon as the user has made their own choice.
 */
function enableAutoStartOnFirstRun(config: AgentConfig): void {
  if (config.autoStart === true || config.autoStartUserManaged === true) {
    return;
  }

  try {
    saveConfig({ autoStart: true });
    autoStartService.apply(true);
    logger.info('Background start enabled: this device is configured');
  } catch (error) {
    // The agent is already running; failing to persist this is not fatal.
    logger.error('Failed to enable background start', { error });
  }
}

/** Reapplies the OS login item to match the persisted autoStart setting. */
function setupAutoStart(): void {
  try {
    const config = loadConfig();
    autoStartService.apply(config.autoStart === true);
  } catch (error) {
    // An incomplete configuration is no reason to change what the OS already
    // does; the setting is reapplied as soon as the config becomes valid.
    logger.warn('Skipped auto-start setup, configuration is incomplete', { error });
  }
}

interface StartAgentOptions {
  /** Suppresses modal dialogs for launches nobody is sitting in front of. */
  silent?: boolean;
}

/**
 * Surfaces a configuration problem that stopped the agent from starting.
 * A background launch has nobody watching, so the problem is logged and handed
 * to the UI rather than blocking on a modal dialog no one would dismiss.
 */
function reportConfigProblem(message: string, detail: string, silent: boolean): void {
  logger.warn(`Agent not started: ${message}`, { detail });

  if (!silent) {
    dialog.showMessageBox({
      type: 'warning',
      title: 'Configuration Required',
      message,
      detail,
      buttons: ['OK']
    });
  }

  // Notify UI to show config section
  if (mainWindow) {
    mainWindow.webContents.send('show-config');
  }
}

/** True when the boot-time service is live and owns reporting for this device. */
async function isReportingOwnedByService(): Promise<boolean> {
  backgroundService = await backgroundServiceDetector.detect();
  return backgroundService.running;
}

async function startAgent(options: StartAgentOptions = {}): Promise<void> {
  const silent = options.silent === true;

  try {
    if (isAgentRunning) {
      return;
    }

    // Checked on every start, not just at launch: the service can be stopped
    // or started at any point while this window is open.
    if (await isReportingOwnedByService()) {
      logger.info('Background service is reporting for this device, leaving the desktop agent idle', {
        kind: backgroundService?.kind,
      });
      updateUI();
      updateTrayMenu();
      return;
    }

    let config: AgentConfig;
    try {
      config = loadConfig();
    } catch (error: any) {
      reportConfigProblem(
        'Agent Configuration Incomplete',
        `${error.message}\n\nOpen the configuration and fill in the missing fields.`,
        silent
      );
      return;
    }

    // Additional validation
    if (!config.assetTag) {
      reportConfigProblem(
        'Asset Tag Required',
        'Asset Tag is required to identify this device. Please open the configuration section and set an Asset Tag.',
        silent
      );
      return;
    }

    agentService = new AgentService(config, processRegistry);
    await agentService.start();
    isAgentRunning = true;

    logger.info('Agent started successfully');
    enableAutoStartOnFirstRun(config);

    // updateUI already sends the complete status to the window
    updateUI();
    updateTrayMenu();
  } catch (error: any) {
    logger.error('Failed to start agent', { error });
    
    // Show more helpful error messages
    let errorDetail = error.message;
    if (error.message.includes('ECONNREFUSED')) {
      errorDetail = 'Cannot connect to the backend API. Please check:\n\n1. The API URL is correct in configuration\n2. The backend server is running\n3. Your network connection';
    } else if (error.message.includes('Unauthorized') || error.message.includes('401')) {
      errorDetail = 'Authentication failed. Please check:\n\n1. The API Key is correct in configuration\n2. The API Key has not expired';
    }

    if (silent) {
      // Nobody is watching a background launch. The agent retries on the next
      // launch, and the failure is already recorded in the log.
      logger.warn('Suppressed agent startup dialog for background launch', { errorDetail });
      return;
    }

    dialog.showMessageBox({
      type: 'error',
      title: 'Failed to Start Agent',
      message: 'Agent startup failed',
      detail: errorDetail,
      buttons: ['OK']
    });
  }
}

async function stopAgent(): Promise<void> {
  try {
    if (!isAgentRunning || !agentService) {
      return;
    }

    await agentService.stop();
    isAgentRunning = false;
    agentService = null;

    logger.info('Agent stopped successfully');

    // updateUI already sends the complete status to the window
    updateUI();
    updateTrayMenu();
  } catch (error: any) {
    logger.error('Failed to stop agent', { error });
  }
}

function updateTrayMenu(): void {
  if (!tray) return;

  const { menu: contextMenu, tooltip: tooltipText } = buildTrayMenu();
  tray.setToolTip(tooltipText);
  tray.setContextMenu(contextMenu);
}

/** The status shared by the window, the tray and the status IPC call. */
function buildAgentStatus() {
  const managedByService = backgroundService?.running === true;

  return {
    running: isAgentRunning,
    status: isAgentRunning ? 'Running' : managedByService ? 'Running as a service' : 'Stopped',
    online: agentService ? agentService.getOnlineStatus() : null,
    managedByService,
    serviceKind: managedByService ? backgroundService?.kind ?? null : null
  };
}

function updateUI(): void {
  if (mainWindow) {
    mainWindow.webContents.send('agent-status-changed', buildAgentStatus());
  }
}

function startAgentOnLaunch(): void {
  startAgent({ silent: launchedInBackground }).catch((error) => {
    logger.error('Failed to auto-start agent on application launch', { error });
  });
}

/** The most useful message from a failed backend call, for showing to the user. */
function backendErrorMessage(error: any, fallback: string): string {
  if (!error.response) {
    return error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND' || error.code === 'ECONNABORTED'
      ? 'Unable to reach the Novaris backend. Check your connection and the backend API URL in Settings.'
      : error.message || fallback;
  }
  const data = error.response.data;
  const details = Array.isArray(data?.errors) ? data.errors.map((d: any) => d?.message).filter(Boolean).join('; ') : '';
  return details || data?.error?.message || data?.error || data?.message || fallback;
}

// IPC handlers
ipcMain.handle('get-agent-status', async () => {
  // Refreshed here so a window opened later reflects the service accurately
  if (!isAgentRunning) {
    await isReportingOwnedByService();
  }

  return buildAgentStatus();
});

ipcMain.handle('get-process-registry', () => processRegistry.snapshot());
ipcMain.handle('get-agent-logs', (_event, lines?: number) => processRegistry.readLogs(lines));

ipcMain.handle('get-app-version', () => {
  return {
    version: getCurrentVersion(),
  };
});

ipcMain.handle('check-for-update', async () => {
  try {
    return await checkForUpdate();
  } catch (error: any) {
    logger.error('Failed to check for update', { error });
    return {
      updateAvailable: false,
      currentVersion: getCurrentVersion(),
      latestVersion: null,
      updateInfo: null,
      message: error.message || 'Failed to check updates',
      error: true,
    };
  }
});

ipcMain.handle('download-and-install-update', async () => {
  try {
    return await downloadAndInstallUpdate();
  } catch (error: any) {
    logger.error('Failed to download/install update', { error });
    return {
      success: false,
      message: error.message || 'Failed to download/update installer',
    };
  }
});

ipcMain.handle('agent-runtime-status', () => agentRuntime.status());


ipcMain.handle('user-session-status', () => userSession.status());

ipcMain.handle('user-login', async (_event, email: string, password: string) => {
  try {
    if (typeof email !== 'string' || !email.trim() || typeof password !== 'string' || !password) {
      throw new Error('Enter your email and password');
    }
    return { success: true, status: await userSession.login(email.trim(), password) };
  } catch (error: any) {
    // Never log the password; the backend message is safe to show.
    logger.warn('User sign-in failed', { status: error.response?.status, message: error.message });
    return { success: false, status: userSession.status(), message: backendErrorMessage(error, 'Sign-in failed') };
  }
});

ipcMain.handle('user-logout', () => userSession.logout());

ipcMain.handle('user-change-password', async (_event, currentPassword: string, newPassword: string, confirmation: string) => {
  try {
    return { success: true, status: await userSession.changePassword(currentPassword, newPassword, confirmation) };
  } catch (error: any) {
    return { success: false, status: userSession.status(), message: backendErrorMessage(error, 'Password change failed') };
  }
});

// Self-service requests. Each handler returns { success, data } or { success: false, message }.
function helpdeskHandler<A extends unknown[]>(channel: string, fallback: string, run: (...args: A) => Promise<unknown>): void {
  ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    try {
      return { success: true, data: await run(...(args as A)) };
    } catch (error: any) {
      logger.warn('Helpdesk request failed', { channel, status: error.response?.status, message: error.message });
      return { success: false, message: backendErrorMessage(error, fallback) };
    }
  });
}
helpdeskHandler('helpdesk-list-tickets', 'Unable to load your tickets', (status?: unknown) => helpdesk.listTickets(status));
helpdeskHandler('helpdesk-create-ticket', 'Unable to create the ticket', (input: unknown) => helpdesk.createTicket(input));
helpdeskHandler('helpdesk-asset-categories', 'Unable to load asset categories', () => helpdesk.listAssetCategories());
helpdeskHandler('helpdesk-request-asset', 'Unable to submit the asset request', (input: unknown) => helpdesk.requestAsset(input));
helpdeskHandler('helpdesk-access-systems', 'Unable to load systems', () => helpdesk.listAccessSystems());
helpdeskHandler('helpdesk-request-access', 'Unable to submit the access request', (input: unknown) => helpdesk.requestAccess(input));

ipcMain.handle('agent-chat-connect', async () => {
  try {
    return await agentChatService.connect();
  } catch (error: any) {
    return { success: false, message: error.message || 'Failed to connect to the assistant' };
  }
});
ipcMain.handle('agent-chat-session-create', async () => agentChatService.createSession());
ipcMain.handle('agent-chat-send', async (_event, text: string) => {
  // Refreshes the JWT when it is close to expiry so a long chat never runs on a stale token.
  await agentRuntime.refreshAccessToken().catch((error) =>
    logger.warn('Failed to refresh the assistant token', { error: error.message }));
  return agentChatService.sendMessage(text);
});
ipcMain.handle('agent-chat-respond', async (_event, type: AgentChatResponseType, value: string, requestId?: string, sessionId?: string) =>
  agentChatService.respondToRequest(type, value, requestId, sessionId));
ipcMain.handle('agent-chat-disconnect', () => agentChatService.disconnect());
ipcMain.on('agent-chat-listen', (event) => {
  agentChatService.setEventListener((chatEvent) => {
    if (!event.sender.isDestroyed()) event.sender.send('agent-chat-event', chatEvent);
  });
});

ipcMain.handle('start-agent', async () => {
  console.log('IPC: start-agent called');
  try {
    await startAgent();
    console.log('IPC: start-agent completed successfully');
  } catch (error) {
    console.error('IPC: start-agent failed:', error);
    throw error;
  }
});

ipcMain.handle('stop-agent', async () => {
  await stopAgent();
});

ipcMain.handle('get-config', () => {
  try {
    // Not loadConfig: a configuration that is still missing a required field
    // must come back with the values already saved, not as blank defaults.
    return readConfig();
  } catch (error) {
    logger.error('Failed to read configuration, returning defaults', { error });
    return { ...DEFAULT_CONFIG } as AgentConfig;
  }
});

// Looks up an asset tag before Settings saves it, so the user can confirm which
// asset this device will be linked to. The URL and key typed in the form are
// used when given (the key field is blank when it is unchanged); otherwise the
// saved ones. Only a display summary of the asset reaches the renderer.
ipcMain.handle('lookup-asset', async (_event, request: { assetTag?: string; apiUrl?: string; apiKey?: string }) => {
  const assetTag = typeof request?.assetTag === 'string' ? request.assetTag.trim() : '';
  if (!assetTag) {
    return { status: 'error', error: 'Asset tag is required' };
  }
  let saved: Partial<AgentConfig> = {};
  try {
    saved = readConfig();
  } catch {
    // Nothing saved yet: the form must supply the connection.
  }
  const apiUrl = (request.apiUrl || saved.apiUrl || '').replace(/\/+$/, '');
  const apiKey = request.apiKey || saved.apiKey;
  if (!apiUrl || !apiKey) {
    return { status: 'error', error: 'Backend API URL and API key are required to look up the asset' };
  }

  try {
    const response = await axios.get(`${apiUrl}/assets/by-tag/${encodeURIComponent(assetTag)}`, {
      headers: { 'X-API-Key': apiKey },
      timeout: 15000,
    });
    const asset = response.data?.data;
    if (!asset) {
      return { status: 'not_found', assetTag };
    }
    return {
      status: 'found',
      asset: {
        id: asset.id,
        assetTag: asset.asset_tag,
        name: asset.name,
        assetType: asset.asset_type,
        brand: asset.brand,
        model: asset.model,
        serialNumber: asset.serial_number,
        status: asset.status,
        lifecycleStatus: asset.lifecycle_status,
        location: asset.location_platform,
        clientName: asset.client_name,
      },
    };
  } catch (error: any) {
    if (axios.isAxiosError(error) && error.response?.status === 404) {
      return { status: 'not_found', assetTag };
    }
    if (axios.isAxiosError(error) && (error.response?.status === 401 || error.response?.status === 403)) {
      return { status: 'error', error: 'The backend rejected the API key' };
    }
    logger.warn('Asset lookup failed', { assetTag, error: error.message });
    return { status: 'error', error: `Unable to reach the backend: ${error.message}` };
  }
});

ipcMain.handle('save-config', async (event, newConfig: Partial<AgentConfig>) => {
  try {
    // saveConfig merges into the file on disk, so a still-incomplete config can
    // be completed here rather than being rejected by loadConfig first. Only
    // the field names are logged: the payload carries the API key.
    saveConfig({ ...newConfig, ...(typeof newConfig.autoStart === "boolean" ? { autoStartUserManaged: true } : {}) });
    logger.info('Configuration saved', { fields: Object.keys(newConfig) });

    // Match the OS login item to the configuration that was just written
    setupAutoStart();

    // Restart agent if it's running to apply new config
    if (isAgentRunning) {
      await stopAgent();
      setTimeout(() => startAgent(), 1000); // Small delay to ensure clean shutdown
    }

    return { success: true };
  } catch (error: any) {
    logger.error('Failed to save configuration', { error });
    return { success: false, error: error.message };
  }
});

const yaraPluginService = new YaraPluginService();

ipcMain.handle('yara-plugin-status', () => yaraPluginService.status());

ipcMain.handle('yara-plugin-install', async () => {
  try {
    return { success: true, status: await yaraPluginService.install() };
  } catch (error: any) {
    logger.error('Failed to install YARA plugin', { error });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('yara-plugin-uninstall', async () => {
  try {
    const status = await yaraPluginService.uninstall();
    // Nothing left to scan with, so stop scheduling scans
    if (!status.installed) {
      saveConfig({ collectYaraScan: false });
    }
    return { success: true, status };
  } catch (error: any) {
    logger.error('Failed to remove YARA plugin', { error });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('get-auto-start', () => {
  // Reports what the OS will actually do, rather than what config asked for.
  return { enabled: autoStartService.isEnabled() };
});

ipcMain.handle('set-auto-start', (_event, enabled: unknown) => {
  const shouldEnable = enabled === true;

  try {
    // Recording the choice stops the first-run logic from overriding it later.
    saveConfig({ autoStart: shouldEnable, autoStartUserManaged: true });
    autoStartService.apply(shouldEnable);

    return { success: true, enabled: autoStartService.isEnabled() };
  } catch (error: any) {
    logger.error('Failed to change background start setting', { error, enabled: shouldEnable });
    return { success: false, enabled: autoStartService.isEnabled(), error: error.message };
  }
});

ipcMain.handle('get-logs', async (event, lines: number = 200) => {
  try {
    const logFilePath = path.join(process.cwd(), 'logs', 'novaris-agent.log');
    
    if (!fs.existsSync(logFilePath)) {
      return { logs: [], error: null };
    }

    const logContent = fs.readFileSync(logFilePath, 'utf-8');
    const logLines = logContent.split('\n').filter(line => line.trim() !== '');
    
    // Get last N lines
    const recentLogs = logLines.slice(-lines);
    
    return { logs: recentLogs, error: null };
  } catch (error: any) {
    logger.error('Failed to read logs', { error });
    return { logs: [], error: error.message };
  }
});

ipcMain.handle('get-system-info', async () => {
  try {
    const deviceInfoCollector = new DeviceInfoCollector();
    const healthMetricsCollector = new HealthMetricsCollector();
    
    const deviceInfo = await deviceInfoCollector.collect();
    const healthMetrics = await healthMetricsCollector.collect();
    
    return {
      deviceInfo,
      healthMetrics,
      error: null
    };
  } catch (error: any) {
    logger.error('Failed to get system info', { error });
    return {
      deviceInfo: null,
      healthMetrics: null,
      error: error.message
    };
  }
});

ipcMain.handle('open-config', async () => {
  try {
    const configPath = path.join(getInstallDirectory(), 'config.json');
    console.log('Opening config file:', configPath);
    
    if (fs.existsSync(configPath)) {
      await shell.openPath(configPath);
      return { success: true };
    } else {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Config Not Found',
        message: 'Configuration file not found',
        detail: `Config file does not exist at:\n${configPath}\n\nIt will be created when the agent starts.`
      });
      return { success: false, error: 'Config file not found' };
    }
  } catch (error: any) {
    logger.error('Failed to open config', { error });
    return { success: false, error: error.message };
  }
});

ipcMain.handle('open-logs', async () => {
  try {
    const logsPath = path.join(getInstallDirectory(), 'logs');
    console.log('Opening logs folder:', logsPath);
    
    if (fs.existsSync(logsPath)) {
      await shell.openPath(logsPath);
      return { success: true };
    } else {
      dialog.showMessageBox({
        type: 'info',
        title: 'Logs Not Found',
        message: 'Logs folder not found',
        detail: `Logs folder does not exist yet at:\n${logsPath}\n\nIt will be created when the agent starts.`
      });
      return { success: false, error: 'Logs folder not found' };
    }
  } catch (error: any) {
    logger.error('Failed to open logs', { error });
    return { success: false, error: error.message };
  }
});

// App event handlers
if (!hasSingleInstanceLock) {
  // Another instance already owns the agent. Hand the launch over to it.
  logger.info('Another instance is already running, exiting this one');
  app.quit();
} else {
  app.on('second-instance', () => {
    // A manual launch while we sit in the tray means the user wants the window.
    revealMainWindow();
  });

  app.whenReady().then(() => {
    createTray();
    createWindow({ startHidden: launchedInBackground });
    setupAutoStart();
    startAgentOnLaunch();
    userSession.restore();

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

app.on('window-all-closed', () => {
  // On macOS, keep app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  isQuitting = true;

  agentChatService.dispose();

  // Stop agent before quitting
  if (isAgentRunning && agentService) {
    event.preventDefault();
    await stopAgent();
    await agentRuntime.stop();
    app.quit();
  } else {
    await agentRuntime.stop();
  }
});

// Handle app being reopened (macOS)
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});
