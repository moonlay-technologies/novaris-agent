import * as fs from 'fs';
import * as path from 'path';
import { AgentConfig, DEFAULT_CONFIG } from '../types/config';

const CONFIG_FILE = path.join(process.cwd(), 'config.json');
const ENV_CONFIG_FILE = process.env.NOVARIS_CONFIG_FILE || CONFIG_FILE;

export function loadConfig(): AgentConfig {
  // First, try to load from environment variables
  const envConfig: Partial<AgentConfig> = {
    apiUrl: process.env.NOVARIS_API_URL || DEFAULT_CONFIG.apiUrl,
    apiKey: process.env.NOVARIS_API_KEY || DEFAULT_CONFIG.apiKey,
    deviceId: process.env.NOVARIS_DEVICE_ID ? parseInt(process.env.NOVARIS_DEVICE_ID, 10) : undefined,
    hostname: process.env.NOVARIS_HOSTNAME,
    collectInterval: process.env.NOVARIS_COLLECT_INTERVAL
      ? parseInt(process.env.NOVARIS_COLLECT_INTERVAL, 10)
      : DEFAULT_CONFIG.collectInterval,
    reportInterval: process.env.NOVARIS_REPORT_INTERVAL
      ? parseInt(process.env.NOVARIS_REPORT_INTERVAL, 10)
      : DEFAULT_CONFIG.reportInterval,
    retryAttempts: process.env.NOVARIS_RETRY_ATTEMPTS
      ? parseInt(process.env.NOVARIS_RETRY_ATTEMPTS, 10)
      : DEFAULT_CONFIG.retryAttempts,
    retryDelay: process.env.NOVARIS_RETRY_DELAY
      ? parseInt(process.env.NOVARIS_RETRY_DELAY, 10)
      : DEFAULT_CONFIG.retryDelay,
    logLevel: (process.env.NOVARIS_LOG_LEVEL as AgentConfig['logLevel']) || DEFAULT_CONFIG.logLevel,
    logFile: process.env.NOVARIS_LOG_FILE,
  };

  // Then, try to load from config file
  let fileConfig: Partial<AgentConfig> = {};
  if (fs.existsSync(ENV_CONFIG_FILE)) {
    try {
      const configContent = fs.readFileSync(ENV_CONFIG_FILE, 'utf-8');
      fileConfig = JSON.parse(configContent);
    } catch (error) {
      console.error(`Failed to parse config file: ${ENV_CONFIG_FILE}`, error);
    }
  }

  // Merge: environment variables override file config, file config overrides defaults
  const config: AgentConfig = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    ...envConfig,
  };

  // Validate required fields
  if (!config.apiUrl) {
    throw new Error('API URL is required. Set NOVARIS_API_URL environment variable or config.json');
  }
  if (!config.apiKey) {
    throw new Error('API Key is required. Set NOVARIS_API_KEY environment variable or config.json');
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

