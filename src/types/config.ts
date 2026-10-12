export type AgentMode = 'endpoint' | 'network_gateway';

export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  assetTag: string; // Required: Asset tag to identify the device
  deviceId?: number;
  hostname?: string;
  // Left unset until the first-run picker writes it (like assetTag/apiKey) - its absence is what
  // gates showing that picker, so it must NOT get a DEFAULT_CONFIG value.
  agentMode?: AgentMode;
  collectInterval: number; // in seconds
  reportInterval: number; // in seconds
  retryAttempts: number;
  retryDelay: number; // in milliseconds
  collectSoftware: boolean;
  softwareCollectionInterval: number; // number of report iterations between software collections
  collectConnectedDevices: boolean;
  collectNetworkNeighbors: boolean;
  collectPatchStatus: boolean;
  patchStatusInterval: number; // in seconds
  collectSecurityPosture: boolean;
  securityPostureInterval: number; // in seconds
  collectLogs: boolean;
  logsInterval: number; // in seconds
  logsMaxBatchSize: number;
  logsMinSeverity: 'info' | 'warning' | 'error' | 'critical';
  logsIncludeRaw: boolean;
  collectSecurityEvents: boolean;
  securityEventsMinSeverity: 'info' | 'warning' | 'error' | 'critical';
  logsCursor?: {
    last_collected_at?: string;
  };
  collectProcesses: boolean;
  processInterval: number; // in seconds
  collectYaraScan: boolean;
  yaraScanInterval: number; // in seconds
  yaraScanPaths?: string[]; // overrides the platform-default scan directories when set
  yaraScanMaxFiles: number;
  yaraScanMaxFileSizeBytes: number;
  pollResponseActions: boolean;
  responseActionsInterval: number; // in seconds
  responseActionTimeout: number; // in seconds
  remoteActionsEnabled: boolean;
  responseActionsDryRun: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  logFile?: string;
  autoStart: boolean; // Whether to launch the application automatically on system startup

  // --- Network Gateway mode (agentMode === 'network_gateway') ---
  // These flags exist independently of agentMode - the mode picker just sets sensible
  // defaults when chosen; agentService.ts checks each flag the same way it checks every
  // other collect* flag, with no special-cased mode branch.
  collectSyslog: boolean;
  syslogPort: number;
  syslogInterval: number; // in seconds - how often batched syslog messages are evaluated/reported

  collectSnmp: boolean;
  snmpTargets: string[];
  snmpCommunity: string;
  snmpInterval: number; // in seconds

  collectActiveDiscovery: boolean;
  activeDiscoveryInterval: number; // in seconds
  /** Persisted MAC allowlist so re-detecting the same device doesn't re-fire an event every cycle. */
  knownNetworkDevices?: string[];

  collectZeekLogs: boolean;
  zeekLogDir?: string; // override the platform-conventional Zeek log directory
  zeekLogsInterval: number; // in seconds
}

export const DEFAULT_CONFIG: Partial<AgentConfig> = {
  apiUrl: 'http://localhost:3000/api/v1',
  apiKey: '',
  collectInterval: 300, // 5 minutes
  reportInterval: 300, // 5 minutes
  retryAttempts: 3,
  retryDelay: 1000, // 1 second
  collectSoftware: true,
  softwareCollectionInterval: 10, // collect software every 10 report iterations (approximately every 50 minutes if reportInterval is 5 minutes)
  collectConnectedDevices: true,
  collectNetworkNeighbors: false,
  collectPatchStatus: true,
  patchStatusInterval: 21600, // 6 hours
  collectSecurityPosture: true,
  securityPostureInterval: 21600, // 6 hours
  collectLogs: true,
  logsInterval: 300, // 5 minutes
  logsMaxBatchSize: 200,
  logsMinSeverity: 'warning',
  logsIncludeRaw: false,
  collectSecurityEvents: true,
  securityEventsMinSeverity: 'warning',
  collectProcesses: true,
  processInterval: 60, // 1 minute
  collectYaraScan: true,
  yaraScanInterval: 86400, // 24 hours - a real content scan is far more expensive than the other periodic checks
  yaraScanMaxFiles: 500,
  yaraScanMaxFileSizeBytes: 25 * 1024 * 1024, // 25MB
  pollResponseActions: true,
  responseActionsInterval: 60, // 1 minute
  responseActionTimeout: 30, // 30 seconds
  remoteActionsEnabled: false,
  responseActionsDryRun: true,
  logLevel: 'info',
  autoStart: false, // Application startup at login disabled by default

  // Network Gateway mode flags all default off - the first-run "Network Gateway Agent"
  // picker is what turns these on; existing/default installs see zero behavior change.
  collectSyslog: false,
  syslogPort: 514,
  syslogInterval: 60, // 1 minute
  collectSnmp: false,
  snmpTargets: [],
  snmpCommunity: 'public',
  snmpInterval: 300, // 5 minutes
  collectActiveDiscovery: false,
  activeDiscoveryInterval: 900, // 15 minutes
  collectZeekLogs: false, // off even in gateway mode by default - requires Zeek already installed by the operator
  zeekLogsInterval: 120, // 2 minutes
};

