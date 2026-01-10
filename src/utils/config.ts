import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, DEFAULT_CONFIG } from '../types/config';

// Get the installation directory (where the executable is located)
// For packaged apps, this is the installation folder
// For development, this is the project root
const getInstallDir = (): string => {
  if (process.env.NODE_ENV === 'development') {
    return process.cwd();
  }
  // In production, use the directory containing the executable
  return path.dirname(process.execPath);
};

const INSTALL_DIR = getInstallDir();
const CONFIG_FILE = path.join(INSTALL_DIR, 'config.json');
const ENV_CONFIG_FILE = process.env.NOVARIS_CONFIG_FILE || CONFIG_FILE;

// Export install directory for use in other modules (like logger)
export const getInstallDirectory = (): string => INSTALL_DIR;

export function loadConfig(): AgentConfig {
  // Create default config file if it doesn't exist
  if (!fs.existsSync(ENV_CONFIG_FILE)) {
    try {
      const defaultConfigContent = {
        apiUrl: 'http://localhost:3000/api/v1',
        apiKey: '',
        assetTag: '',
        collectInterval: 300,
        reportInterval: 300,
        retryAttempts: 3,
        retryDelay: 1000,
        collectSoftware: true,
        softwareCollectionInterval: 10,
        collectPatchStatus: true,
        patchStatusInterval: 21600,
        collectLogs: true,
        logsInterval: 300,
        logsMaxBatchSize: 200,
        logsMinSeverity: 'warning',
        logsIncludeRaw: false,
        collectProcesses: true,
        processInterval: 60,
        logLevel: 'info',
        autoStart: false
      };
      
      fs.writeFileSync(
        ENV_CONFIG_FILE, 
        JSON.stringify(defaultConfigContent, null, 2),
        'utf-8'
      );
      console.log(`Created default config file at: ${ENV_CONFIG_FILE}`);
    } catch (error) {
      console.error(`Failed to create default config file: ${ENV_CONFIG_FILE}`, error);
    }
  }

  // First, try to load from config file
  let fileConfig: Partial<AgentConfig> = {};
  if (fs.existsSync(ENV_CONFIG_FILE)) {
    try {
      const configContent = fs.readFileSync(ENV_CONFIG_FILE, 'utf-8');
      fileConfig = JSON.parse(configContent);
    } catch (error) {
      console.error(`Failed to parse config file: ${ENV_CONFIG_FILE}`, error);
    }
  }

  // Then, load from environment variables (only if they're actually set)
  const envConfig: Partial<AgentConfig> = {};
  if (process.env.NOVARIS_API_URL) {
    envConfig.apiUrl = process.env.NOVARIS_API_URL;
  }
  if (process.env.NOVARIS_API_KEY) {
    envConfig.apiKey = process.env.NOVARIS_API_KEY;
  }
  if (process.env.NOVARIS_DEVICE_ID) {
    envConfig.deviceId = parseInt(process.env.NOVARIS_DEVICE_ID, 10);
  }
  if (process.env.NOVARIS_HOSTNAME) {
    envConfig.hostname = process.env.NOVARIS_HOSTNAME;
  }
  if (process.env.NOVARIS_ASSET_TAG) {
    envConfig.assetTag = process.env.NOVARIS_ASSET_TAG;
  }
  if (process.env.NOVARIS_COLLECT_INTERVAL) {
    envConfig.collectInterval = parseInt(process.env.NOVARIS_COLLECT_INTERVAL, 10);
  }
  if (process.env.NOVARIS_REPORT_INTERVAL) {
    envConfig.reportInterval = parseInt(process.env.NOVARIS_REPORT_INTERVAL, 10);
  }
  if (process.env.NOVARIS_RETRY_ATTEMPTS) {
    envConfig.retryAttempts = parseInt(process.env.NOVARIS_RETRY_ATTEMPTS, 10);
  }
  if (process.env.NOVARIS_RETRY_DELAY) {
    envConfig.retryDelay = parseInt(process.env.NOVARIS_RETRY_DELAY, 10);
  }
  if (process.env.NOVARIS_COLLECT_PATCH_STATUS) {
    const raw = process.env.NOVARIS_COLLECT_PATCH_STATUS.trim().toLowerCase();
    envConfig.collectPatchStatus = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_PATCH_STATUS_INTERVAL) {
    envConfig.patchStatusInterval = parseInt(process.env.NOVARIS_PATCH_STATUS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_COLLECT_LOGS) {
    const raw = process.env.NOVARIS_COLLECT_LOGS.trim().toLowerCase();
    envConfig.collectLogs = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_LOGS_INTERVAL) {
    envConfig.logsInterval = parseInt(process.env.NOVARIS_LOGS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_LOGS_MAX_BATCH_SIZE) {
    envConfig.logsMaxBatchSize = parseInt(process.env.NOVARIS_LOGS_MAX_BATCH_SIZE, 10);
  }
  if (process.env.NOVARIS_LOGS_MIN_SEVERITY) {
    const raw = process.env.NOVARIS_LOGS_MIN_SEVERITY.trim().toLowerCase();
    if (raw === 'info' || raw === 'warning' || raw === 'error' || raw === 'critical') {
      envConfig.logsMinSeverity = raw as AgentConfig['logsMinSeverity'];
    }
  }
  if (process.env.NOVARIS_LOGS_INCLUDE_RAW) {
    const raw = process.env.NOVARIS_LOGS_INCLUDE_RAW.trim().toLowerCase();
    envConfig.logsIncludeRaw = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_COLLECT_PROCESSES) {
    const raw = process.env.NOVARIS_COLLECT_PROCESSES.trim().toLowerCase();
    envConfig.collectProcesses = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_PROCESS_INTERVAL) {
    envConfig.processInterval = parseInt(process.env.NOVARIS_PROCESS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_LOG_LEVEL) {
    envConfig.logLevel = process.env.NOVARIS_LOG_LEVEL as AgentConfig['logLevel'];
  }
  if (process.env.NOVARIS_LOG_FILE) {
    envConfig.logFile = process.env.NOVARIS_LOG_FILE;
  }
  if (process.env.NOVARIS_AUTO_START) {
    const raw = process.env.NOVARIS_AUTO_START.trim().toLowerCase();
    envConfig.autoStart = raw === 'true' || raw === '1' || raw === 'yes';
  }

  // Merge: defaults -> file config -> environment variables (env overrides file, file overrides defaults)
  const config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
  } as AgentConfig;

  // Validate required fields
  if (!config.apiUrl) {
    throw new Error('API URL is required. Set NOVARIS_API_URL environment variable or config.json');
  }
  if (!config.apiKey) {
    throw new Error('API Key is required. Set NOVARIS_API_KEY environment variable or config.json');
  }
  if (!config.assetTag) {
    throw new Error('Asset Tag is required. Set NOVARIS_ASSET_TAG environment variable or config.json');
  }

  return config;
}

export function saveConfig(config: Partial<AgentConfig>): void {
  try {
    const existingConfig = fs.existsSync(ENV_CONFIG_FILE)
      ? JSON.parse(fs.readFileSync(ENV_CONFIG_FILE, 'utf-8'))
      : {};
    const mergedConfig = { ...existingConfig, ...config };
    fs.writeFileSync(ENV_CONFIG_FILE, JSON.stringify(mergedConfig, null, 2));
  } catch (error) {
    console.error(`Failed to save config file: ${ENV_CONFIG_FILE}`, error);
  }
}

