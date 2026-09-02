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

// The fields the agent cannot run without, in the order they are reported.
const REQUIRED_FIELDS: ReadonlyArray<{
  key: 'apiUrl' | 'apiKey' | 'assetTag';
  label: string;
  envVar: string;
}> = [
  { key: 'apiUrl', label: 'API URL', envVar: 'NOVARIS_API_URL' },
  { key: 'apiKey', label: 'API Key', envVar: 'NOVARIS_API_KEY' },
  { key: 'assetTag', label: 'Asset Tag', envVar: 'NOVARIS_ASSET_TAG' },
];

export interface ConfigValidationResult {
  valid: boolean;
  /** Readable names of the required fields that are still empty. */
  missing: string[];
  /** Ready to show explanation of what is missing, or null when valid. */
  message: string | null;
}

/**
 * Reports whether the device is configured well enough for the agent to run.
 * Unlike loadConfig this never throws, so callers can treat "not configured
 * yet" as an ordinary state rather than an error.
 */
export function validateConfig(config: Partial<AgentConfig>): ConfigValidationResult {
  const empty = REQUIRED_FIELDS.filter((field) => !config[field.key]);

  return {
    valid: empty.length === 0,
    missing: empty.map((field) => field.label),
    message: empty.length === 0
      ? null
      : `${empty.map((field) => field.label).join(', ')} ${empty.length > 1 ? 'are' : 'is'} required. `
        + `Set ${empty.map((field) => field.envVar).join(', ')} or the matching fields in config.json`,
  };
}

export function loadConfig(): AgentConfig {
  // Create default config file if it doesn't exist
  if (!fs.existsSync(ENV_CONFIG_FILE)) {
    try {
      // Derived from the shared defaults so the two cannot drift apart. The
      // required fields are seeded empty for the operator to fill in.
      const defaultConfigContent = { ...DEFAULT_CONFIG, assetTag: '' };

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
  if (process.env.NOVARIS_COLLECT_CONNECTED_DEVICES) {
    const raw = process.env.NOVARIS_COLLECT_CONNECTED_DEVICES.trim().toLowerCase();
    envConfig.collectConnectedDevices = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_COLLECT_NETWORK_NEIGHBORS) {
    const raw = process.env.NOVARIS_COLLECT_NETWORK_NEIGHBORS.trim().toLowerCase();
    envConfig.collectNetworkNeighbors = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_PATCH_STATUS_INTERVAL) {
    envConfig.patchStatusInterval = parseInt(process.env.NOVARIS_PATCH_STATUS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_COLLECT_SECURITY_POSTURE) {
    const raw = process.env.NOVARIS_COLLECT_SECURITY_POSTURE.trim().toLowerCase();
    envConfig.collectSecurityPosture = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_SECURITY_POSTURE_INTERVAL) {
    envConfig.securityPostureInterval = parseInt(process.env.NOVARIS_SECURITY_POSTURE_INTERVAL, 10);
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
  if (process.env.NOVARIS_COLLECT_SECURITY_EVENTS) {
    const raw = process.env.NOVARIS_COLLECT_SECURITY_EVENTS.trim().toLowerCase();
    envConfig.collectSecurityEvents = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_SECURITY_EVENTS_MIN_SEVERITY) {
    const raw = process.env.NOVARIS_SECURITY_EVENTS_MIN_SEVERITY.trim().toLowerCase();
    if (raw === 'info' || raw === 'warning' || raw === 'error' || raw === 'critical') {
      envConfig.securityEventsMinSeverity = raw as AgentConfig['securityEventsMinSeverity'];
    }
  }
  if (process.env.NOVARIS_COLLECT_PROCESSES) {
    const raw = process.env.NOVARIS_COLLECT_PROCESSES.trim().toLowerCase();
    envConfig.collectProcesses = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_PROCESS_INTERVAL) {
    envConfig.processInterval = parseInt(process.env.NOVARIS_PROCESS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_POLL_RESPONSE_ACTIONS) {
    const raw = process.env.NOVARIS_POLL_RESPONSE_ACTIONS.trim().toLowerCase();
    envConfig.pollResponseActions = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_RESPONSE_ACTIONS_INTERVAL) {
    envConfig.responseActionsInterval = parseInt(process.env.NOVARIS_RESPONSE_ACTIONS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_RESPONSE_ACTION_TIMEOUT) {
    envConfig.responseActionTimeout = parseInt(process.env.NOVARIS_RESPONSE_ACTION_TIMEOUT, 10);
  }
  if (process.env.NOVARIS_REMOTE_ACTIONS_ENABLED) {
    const raw = process.env.NOVARIS_REMOTE_ACTIONS_ENABLED.trim().toLowerCase();
    envConfig.remoteActionsEnabled = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_RESPONSE_ACTIONS_DRY_RUN) {
    const raw = process.env.NOVARIS_RESPONSE_ACTIONS_DRY_RUN.trim().toLowerCase();
    envConfig.responseActionsDryRun = raw === '1' || raw === 'true' || raw === 'yes';
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

  // Validate required fields, naming all of them rather than one per attempt
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(validation.message as string);
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

