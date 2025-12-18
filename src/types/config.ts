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
  logLevel: 'info',
};

