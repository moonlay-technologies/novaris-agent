import { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { AgentService } from '../dist/services/agentService';
import { loadConfig, saveConfig, getInstallDirectory } from '../dist/utils/config';
import { AgentConfig, DEFAULT_CONFIG } from '../dist/types/config';
import { createLogger } from '../dist/utils/logger';
import { DeviceInfoCollector } from '../dist/collectors/deviceInfoCollector';
import { HealthMetricsCollector } from '../dist/collectors/healthMetricsCollector';

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let agentService: AgentService | null = null;
let isAgentRunning = false;
let isQuitting = false;

// Load config with error handling for GUI context
let initialConfig: AgentConfig;
try {
  initialConfig = loadConfig();
} catch (error) {
  console.warn('Config validation failed, using defaults', error);
  initialConfig = { ...DEFAULT_CONFIG } as AgentConfig;
}
const logger = createLogger(initialConfig);

function createWindow(): void {
  // Create the browser window
  mainWindow = new BrowserWindow({
    width: 500,
    height: 700,
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
    show: true // Show immediately for debugging
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

function createTray(): void {
  // Create tray icon
  const iconPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '../src-electron/assets/favicon.png')
    : path.join(__dirname, 'assets/favicon.png');
  
  try {
    tray = new Tray(iconPath);

    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show Novaris Agent',
        click: () => {
          if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
          } else {
            createWindow();
          }
        }
      },
      { type: 'separator' },
      {
        label: `Status: ${isAgentRunning ? 'Running' : 'Stopped'}`,
        enabled: false
      },
      { type: 'separator' },
      {
        label: 'Start Agent',
        click: () => startAgent(),
        enabled: !isAgentRunning
      },
      {
        label: 'Stop Agent',
        click: () => stopAgent(),
        enabled: isAgentRunning
      },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          app.quit();
        }
      }
    ]);

    const tooltipText = isAgentRunning 
      ? 'Novaris Agent - Running' 
      : 'Novaris Agent - Stopped';
    tray.setToolTip(tooltipText);
    tray.setContextMenu(contextMenu);

    // Double-click tray icon to show window
    tray.on('double-click', () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
  } catch (error) {
    logger.warn('Failed to create tray icon, skipping tray functionality', { error });
    // Continue without tray
  }
}

function setupAutoStart(): void {
  try {
    const config = loadConfig();
    if (config.autoStart) {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: []
      });
      logger.info('Auto-start enabled');
    } else {
      app.setLoginItemSettings({
        openAtLogin: false
      });
      logger.info('Auto-start disabled');
    }
  } catch (error) {
    logger.error('Failed to setup auto-start', { error });
  }
}

async function startAgent(): Promise<void> {
  try {
    if (isAgentRunning) {
      return;
    }

    let config: AgentConfig;
    try {
      config = loadConfig();
    } catch (error: any) {
      // Config validation failed - show friendly message and open config
      const message = `Configuration error: ${error.message}\n\nPlease open the configuration section and set the required fields (API URL, API Key, and Asset Tag).`;
      
      dialog.showMessageBox({
        type: 'warning',
        title: 'Configuration Required',
        message: 'Agent Configuration Incomplete',
        detail: message,
        buttons: ['OK']
      });
      
      // Notify UI to show config section
      if (mainWindow) {
        mainWindow.webContents.send('show-config');
      }
      return;
    }

    // Additional validation
    if (!config.assetTag) {
      dialog.showMessageBox({
        type: 'warning',
        title: 'Configuration Required',
        message: 'Asset Tag Required',
        detail: 'Asset Tag is required to identify this device. Please open the configuration section and set an Asset Tag.',
        buttons: ['OK']
      });
      
      // Notify UI to show config section
      if (mainWindow) {
        mainWindow.webContents.send('show-config');
      }
      return;
    }

    agentService = new AgentService(config);
    await agentService.start();
    isAgentRunning = true;

    logger.info('Agent started successfully');
    updateUI();
    updateTrayMenu();

    // Notify UI
    if (mainWindow) {
      mainWindow.webContents.send('agent-status-changed', { running: true });
    }
  } catch (error: any) {
    logger.error('Failed to start agent', { error });
    
    // Show more helpful error messages
    let errorDetail = error.message;
    if (error.message.includes('ECONNREFUSED')) {
      errorDetail = 'Cannot connect to the backend API. Please check:\n\n1. The API URL is correct in configuration\n2. The backend server is running\n3. Your network connection';
    } else if (error.message.includes('Unauthorized') || error.message.includes('401')) {
      errorDetail = 'Authentication failed. Please check:\n\n1. The API Key is correct in configuration\n2. The API Key has not expired';
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
    updateUI();
    updateTrayMenu();

    // Notify UI
    if (mainWindow) {
      mainWindow.webContents.send('agent-status-changed', { running: false });
    }
  } catch (error: any) {
    logger.error('Failed to stop agent', { error });
  }
}

function updateTrayMenu(): void {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show Novaris Agent',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        } else {
          createWindow();
        }
      }
    },
    { type: 'separator' },
    {
      label: `Status: ${isAgentRunning ? 'Running' : 'Stopped'}`,
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Start Agent',
      click: () => startAgent(),
      enabled: !isAgentRunning
    },
    {
      label: 'Stop Agent',
      click: () => stopAgent(),
      enabled: isAgentRunning
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.quit();
      }
    }
  ]);

  const tooltipText = isAgentRunning 
    ? 'Novaris Agent - Running' 
    : 'Novaris Agent - Stopped';
  tray.setToolTip(tooltipText);
  tray.setContextMenu(contextMenu);
}

function updateUI(): void {
  if (mainWindow) {
    mainWindow.webContents.send('agent-status-changed', {
      running: isAgentRunning,
      status: isAgentRunning ? 'Running' : 'Stopped'
    });
  }
}

// IPC handlers
ipcMain.handle('get-agent-status', () => {
  return {
    running: isAgentRunning,
    status: isAgentRunning ? 'Running' : 'Stopped'
  };
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
    console.log('IPC: get-config called');
    console.log('Current working directory:', process.cwd());
    const config = loadConfig();
    console.log('Config loaded successfully');
    console.log('Config apiUrl:', config.apiUrl);
    console.log('Config assetTag:', config.assetTag);
    return config;
  } catch (error) {
    console.error('Failed to load config in main process, returning defaults:', error);
    console.error('Error details:', error);
    // Return defaults if config loading fails
    return { ...DEFAULT_CONFIG } as AgentConfig;
  }
});

ipcMain.handle('save-config', async (event, newConfig: Partial<AgentConfig>) => {
  try {
    const currentConfig = loadConfig();
    const updatedConfig = { ...currentConfig, ...newConfig };
    saveConfig(updatedConfig);
    logger.info('Configuration saved', { config: updatedConfig });

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
app.whenReady().then(() => {
  createTray();
  createWindow();
  setupAutoStart();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, keep app running even when all windows are closed
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', async (event) => {
  isQuitting = true;
  
  // Stop agent before quitting
  if (isAgentRunning && agentService) {
    event.preventDefault();
    await stopAgent();
    app.quit();
  }
});

// Handle app being reopened (macOS)
app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});