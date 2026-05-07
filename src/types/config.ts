export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  assetTag: string; // Required: Asset tag to identify the device
  deviceId?: number;
  hostname?: string;
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
  pollResponseActions: boolean;
  responseActionsInterval: number; // in seconds
  responseActionTimeout: number; // in seconds
  remoteActionsEnabled: boolean;
  responseActionsDryRun: boolean;
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  logFile?: string;
  autoStart: boolean; // Whether to launch the application automatically on system startup
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
  pollResponseActions: true,
  responseActionsInterval: 60, // 1 minute
  responseActionTimeout: 30, // 30 seconds
  remoteActionsEnabled: false,
  responseActionsDryRun: true,
  logLevel: 'info',
  autoStart: false, // Application startup at login disabled by default
};

