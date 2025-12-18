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
  collectPatchStatus: boolean;
  patchStatusInterval: number; // in seconds
  collectLogs: boolean;
  logsInterval: number; // in seconds
  logsMaxBatchSize: number;
  logsMinSeverity: 'info' | 'warning' | 'error' | 'critical';
  logsIncludeRaw: boolean;
  logsCursor?: {
    last_collected_at?: string;
  };
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  logFile?: string;
}

export const DEFAULT_CONFIG: Partial<AgentConfig> = {
  apiUrl: 'http://localhost:3000/api/v1',
  apiKey: '',
  collectInterval: 300, // 5 minutes
  reportInterval: 300, // 5 minutes
  retryAttempts: 3,
  retryDelay: 1000, // 1 second
  collectSoftware: false,
  collectPatchStatus: true,
  patchStatusInterval: 21600, // 6 hours
  collectLogs: true,
  logsInterval: 300, // 5 minutes
  logsMaxBatchSize: 200,
  logsMinSeverity: 'warning',
  logsIncludeRaw: false,
  logLevel: 'info',
};

