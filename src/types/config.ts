export interface AgentConfig {
  apiUrl: string;
  apiKey: string;
  deviceId?: number;
  hostname?: string;
  collectInterval: number; // in seconds
  reportInterval: number; // in seconds
  retryAttempts: number;
  retryDelay: number; // in milliseconds
  logLevel: 'error' | 'warn' | 'info' | 'debug';
  logFile?: string;
}

export const DEFAULT_CONFIG: AgentConfig = {
  apiUrl: 'http://localhost:3000/api/v1',
  apiKey: '',
  collectInterval: 300, // 5 minutes
  reportInterval: 300, // 5 minutes
  retryAttempts: 3,
  retryDelay: 1000, // 1 second
  logLevel: 'info',
};

