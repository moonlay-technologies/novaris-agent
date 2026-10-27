import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, DEFAULT_CONFIG, ResponseActionsMode, Severity } from '../types/config';

// Get the installation directory (where the executable is located)
// For packaged apps, this is the installation folder
// For development, this is the project root
const getInstallDir = (): string => {
  // Explicit override, for deployments that place the config elsewhere
  if (process.env.NOVARIS_INSTALL_DIR) {
    return process.env.NOVARIS_INSTALL_DIR;
  }

  if (process.env.NODE_ENV === 'development') {
    return process.cwd();
  }

  // Started as a script under plain Node, which is how the background service
  // runs: process.execPath is the Node binary itself, so the installation is
  // the package root above this compiled file, not Node's own folder.
  const executable = path.basename(process.execPath).toLowerCase();
  // The same holds for an unpackaged Electron run (`electron dist-electron/main.js`):
  // process.execPath is node_modules/electron/dist/electron.exe, whose folder
  // is no installation and may hold a stray config.json.
  if (executable === 'node' || executable === 'node.exe' || (process as { defaultApp?: boolean }).defaultApp) {
    return path.resolve(__dirname, '..', '..');
  }

  // Packaged application: the executable sits in the installation folder
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

const SEVERITIES: ReadonlyArray<Severity> = ['info', 'warning', 'error', 'critical'];
const RESPONSE_ACTIONS_MODES: ReadonlyArray<ResponseActionsMode> = ['off', 'acknowledge', 'execute'];

const parseBoolean = (raw: string): boolean => ['1', 'true', 'yes'].includes(raw.trim().toLowerCase());

/** Keys replaced in 1.1: the agent no longer reads them. */
const LEGACY_KEYS = [
  'collectInterval',
  'softwareCollectionInterval',
  'securityEventsMinSeverity',
  'pollResponseActions',
  'remoteActionsEnabled',
  'responseActionsDryRun',
] as const;

type LegacyConfig = Partial<AgentConfig> & {
  collectInterval?: number;
  softwareCollectionInterval?: number;
  securityEventsMinSeverity?: Severity;
  pollResponseActions?: boolean;
  remoteActionsEnabled?: boolean;
  responseActionsDryRun?: boolean;
};

/** The single response-actions mode equivalent to the three switches it replaces. */
function responseActionsModeFrom(poll?: boolean, remoteEnabled?: boolean, dryRun?: boolean): ResponseActionsMode {
  if (poll === false) return 'off';
  // Remote actions were off by default and dry-run was on by default; either one held execution back.
  return remoteEnabled === true && dryRun === false ? 'execute' : 'acknowledge';
}

/**
 * Converts settings written by earlier versions into their replacements and drops
 * the replaced keys. Returns null when there was nothing to convert.
 */
export function migrateLegacyConfig(config: LegacyConfig): Partial<AgentConfig> | null {
  if (!LEGACY_KEYS.some((key) => key in config)) {
    return null;
  }

  const migrated: LegacyConfig = { ...config };

  if (migrated.responseActionsMode === undefined
    && (config.pollResponseActions !== undefined || config.remoteActionsEnabled !== undefined || config.responseActionsDryRun !== undefined)) {
    migrated.responseActionsMode = responseActionsModeFrom(
      config.pollResponseActions,
      config.remoteActionsEnabled,
      config.responseActionsDryRun,
    );
  }

  if (migrated.softwareInterval === undefined && typeof config.softwareCollectionInterval === 'number') {
    // Was counted in report cycles
    const reportInterval = config.reportInterval ?? (DEFAULT_CONFIG.reportInterval as number);
    migrated.softwareInterval = config.softwareCollectionInterval * reportInterval;
  }

  for (const key of LEGACY_KEYS) {
    delete migrated[key];
  }
  return migrated;
}

/**
 * Loads the configuration and requires the fields the agent cannot run without.
 * Use readConfig to show or edit a configuration that may still be incomplete.
 */
export function loadConfig(): AgentConfig {
  const config = readConfig();

  // Validate required fields, naming all of them rather than one per attempt
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(validation.message as string);
  }

  return config;
}

/**
 * The configuration as stored (defaults, then config.json, then environment
 * variables), without validation, so a partly filled-in configuration keeps
 * the values that are already there.
 */
export function readConfig(): AgentConfig {
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

    const migrated = migrateLegacyConfig(fileConfig);
    if (migrated) {
      fileConfig = migrated;
      try {
        fs.writeFileSync(ENV_CONFIG_FILE, JSON.stringify(fileConfig, null, 2), 'utf-8');
      } catch (error) {
        console.error(`Failed to rewrite migrated config file: ${ENV_CONFIG_FILE}`, error);
      }
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
    if (SEVERITIES.includes(raw as Severity)) {
      envConfig.logsMinSeverity = raw as Severity;
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
  if (process.env.NOVARIS_COLLECT_PROCESSES) {
    const raw = process.env.NOVARIS_COLLECT_PROCESSES.trim().toLowerCase();
    envConfig.collectProcesses = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_PROCESS_INTERVAL) {
    envConfig.processInterval = parseInt(process.env.NOVARIS_PROCESS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_COLLECT_YARA_SCAN) {
    const raw = process.env.NOVARIS_COLLECT_YARA_SCAN.trim().toLowerCase();
    envConfig.collectYaraScan = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_YARA_SCAN_INTERVAL) {
    envConfig.yaraScanInterval = parseInt(process.env.NOVARIS_YARA_SCAN_INTERVAL, 10);
  }
  if (process.env.NOVARIS_YARA_SCAN_PATHS) {
    envConfig.yaraScanPaths = process.env.NOVARIS_YARA_SCAN_PATHS.split(',').map((p) => p.trim()).filter(Boolean);
  }
  if (process.env.NOVARIS_YARA_SCAN_MAX_FILES) {
    envConfig.yaraScanMaxFiles = parseInt(process.env.NOVARIS_YARA_SCAN_MAX_FILES, 10);
  }
  if (process.env.NOVARIS_YARA_SCAN_MAX_FILE_SIZE_BYTES) {
    envConfig.yaraScanMaxFileSizeBytes = parseInt(process.env.NOVARIS_YARA_SCAN_MAX_FILE_SIZE_BYTES, 10);
  }
  if (process.env.NOVARIS_AGENT_MODE === 'endpoint' || process.env.NOVARIS_AGENT_MODE === 'network_gateway') {
    envConfig.agentMode = process.env.NOVARIS_AGENT_MODE;
  }
  if (process.env.NOVARIS_COLLECT_SYSLOG) {
    const raw = process.env.NOVARIS_COLLECT_SYSLOG.trim().toLowerCase();
    envConfig.collectSyslog = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_SYSLOG_PORT) {
    envConfig.syslogPort = parseInt(process.env.NOVARIS_SYSLOG_PORT, 10);
  }
  if (process.env.NOVARIS_SYSLOG_INTERVAL) {
    envConfig.syslogInterval = parseInt(process.env.NOVARIS_SYSLOG_INTERVAL, 10);
  }
  if (process.env.NOVARIS_COLLECT_SNMP) {
    const raw = process.env.NOVARIS_COLLECT_SNMP.trim().toLowerCase();
    envConfig.collectSnmp = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_SNMP_TARGETS) {
    envConfig.snmpTargets = process.env.NOVARIS_SNMP_TARGETS.split(',').map((t) => t.trim()).filter(Boolean);
  }
  if (process.env.NOVARIS_SNMP_COMMUNITY) {
    envConfig.snmpCommunity = process.env.NOVARIS_SNMP_COMMUNITY;
  }
  if (process.env.NOVARIS_SNMP_INTERVAL) {
    envConfig.snmpInterval = parseInt(process.env.NOVARIS_SNMP_INTERVAL, 10);
  }
  if (process.env.NOVARIS_COLLECT_ACTIVE_DISCOVERY) {
    const raw = process.env.NOVARIS_COLLECT_ACTIVE_DISCOVERY.trim().toLowerCase();
    envConfig.collectActiveDiscovery = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_ACTIVE_DISCOVERY_INTERVAL) {
    envConfig.activeDiscoveryInterval = parseInt(process.env.NOVARIS_ACTIVE_DISCOVERY_INTERVAL, 10);
  }
  if (process.env.NOVARIS_COLLECT_ZEEK_LOGS) {
    const raw = process.env.NOVARIS_COLLECT_ZEEK_LOGS.trim().toLowerCase();
    envConfig.collectZeekLogs = raw === '1' || raw === 'true' || raw === 'yes';
  }
  if (process.env.NOVARIS_ZEEK_LOG_DIR) {
    envConfig.zeekLogDir = process.env.NOVARIS_ZEEK_LOG_DIR;
  }
  if (process.env.NOVARIS_ZEEK_LOGS_INTERVAL) {
    envConfig.zeekLogsInterval = parseInt(process.env.NOVARIS_ZEEK_LOGS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_SOFTWARE_INTERVAL) {
    envConfig.softwareInterval = parseInt(process.env.NOVARIS_SOFTWARE_INTERVAL, 10);
  }
  if (process.env.NOVARIS_RESPONSE_ACTIONS_MODE) {
    const raw = process.env.NOVARIS_RESPONSE_ACTIONS_MODE.trim().toLowerCase() as ResponseActionsMode;
    if (RESPONSE_ACTIONS_MODES.includes(raw)) {
      envConfig.responseActionsMode = raw;
    }
  } else if (
    process.env.NOVARIS_POLL_RESPONSE_ACTIONS
    || process.env.NOVARIS_REMOTE_ACTIONS_ENABLED
    || process.env.NOVARIS_RESPONSE_ACTIONS_DRY_RUN
  ) {
    // Deprecated switches, still honoured for existing deployments
    const env = (name: string): boolean | undefined =>
      process.env[name] ? parseBoolean(process.env[name] as string) : undefined;
    envConfig.responseActionsMode = responseActionsModeFrom(
      env('NOVARIS_POLL_RESPONSE_ACTIONS'),
      env('NOVARIS_REMOTE_ACTIONS_ENABLED'),
      env('NOVARIS_RESPONSE_ACTIONS_DRY_RUN'),
    );
  }
  if (process.env.NOVARIS_RESPONSE_ACTIONS_INTERVAL) {
    envConfig.responseActionsInterval = parseInt(process.env.NOVARIS_RESPONSE_ACTIONS_INTERVAL, 10);
  }
  if (process.env.NOVARIS_RESPONSE_ACTION_TIMEOUT) {
    envConfig.responseActionTimeout = parseInt(process.env.NOVARIS_RESPONSE_ACTION_TIMEOUT, 10);
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
  return {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
  } as AgentConfig;
}

/** Merges the given fields into config.json. Throws if the file cannot be written. */
export function saveConfig(config: Partial<AgentConfig>): void {
  const existingConfig = fs.existsSync(ENV_CONFIG_FILE)
    ? JSON.parse(fs.readFileSync(ENV_CONFIG_FILE, 'utf-8'))
    : {};
  const mergedConfig = { ...existingConfig, ...config };
  try {
    fs.writeFileSync(ENV_CONFIG_FILE, JSON.stringify(mergedConfig, null, 2));
  } catch (error) {
    throw new Error(`Cannot write ${ENV_CONFIG_FILE}: ${(error as Error).message}`);
  }
}

