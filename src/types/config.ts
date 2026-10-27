export type AgentMode = 'endpoint' | 'network_gateway';

export type Severity = 'info' | 'warning' | 'error' | 'critical';

/**
 * How remote response actions are handled:
 * - off: do not poll for actions at all
 * - acknowledge: poll and acknowledge actions without executing them (dry run)
 * - execute: run allowlisted actions on this device
 */
export type ResponseActionsMode = 'off' | 'acknowledge' | 'execute';

export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  assetTag: string; // Required: Asset tag to identify the device
  deviceId?: number;
  // Asset tag deviceId was resolved for. When it no longer matches assetTag the
  // device is looked up again, so changing the tag re-links the agent.
  deviceAssetTag?: string;
  hostname?: string;
  // Left unset until the first-run picker writes it (like assetTag/apiKey) - its absence is what
  // gates showing that picker, so it must NOT get a DEFAULT_CONFIG value. Network monitoring
  // collectors only run in 'network_gateway' mode; unset is treated as 'endpoint'.
  agentMode?: AgentMode;
  reportInterval: number; // in seconds
  retryAttempts: number;
  retryDelay: number; // in milliseconds
  collectSoftware: boolean;
  softwareInterval: number; // in seconds
  collectConnectedDevices: boolean;
  collectNetworkNeighbors: boolean;
  collectPatchStatus: boolean;
  patchStatusInterval: number; // in seconds
  collectSecurityPosture: boolean;
  securityPostureInterval: number; // in seconds
  collectLogs: boolean;
  logsInterval: number; // in seconds
  logsMaxBatchSize: number;
  logsMinSeverity: Severity; // applies to collected logs and to every security event source
  logsIncludeRaw: boolean;
  collectSecurityEvents: boolean;
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
  responseActionsMode: ResponseActionsMode;
  responseActionsInterval: number; // in seconds
  responseActionTimeout: number; // in seconds
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  logFile?: string;
  autoStart: boolean; // Whether to launch the application automatically on system startup

  // --- Network Gateway mode (agentMode === 'network_gateway') ---
  // Ignored in endpoint mode. The mode picker turns on sensible defaults when gateway is chosen.
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
  // Set once the user makes their own choice about autoStart. While unset the
  // agent may turn autoStart on by itself, the first time the device is fully
  // configured; afterwards the user's choice is left alone.
  autoStartUserManaged?: boolean;
}

export const DEFAULT_CONFIG: Partial<AgentConfig> = {
  apiUrl: 'http://localhost:3000/api/v1',
  apiKey: '',
  reportInterval: 300, // 5 minutes
  retryAttempts: 3,
  retryDelay: 1000, // 1 second
  collectSoftware: true,
  softwareInterval: 3600, // 1 hour - installed software changes rarely
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
  collectProcesses: false, // Optional investigation snapshots; enable deliberately when needed
  processInterval: 60, // 1 minute
  collectYaraScan: true,
  yaraScanInterval: 86400, // 24 hours - a real content scan is far more expensive than the other periodic checks
  yaraScanMaxFiles: 500,
  yaraScanMaxFileSizeBytes: 25 * 1024 * 1024, // 25MB
  responseActionsMode: 'acknowledge',
  responseActionsInterval: 60, // 1 minute
  responseActionTimeout: 30, // 30 seconds
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

