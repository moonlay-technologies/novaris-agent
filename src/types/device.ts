export interface DeviceInfo {
  hostname: string;
  serialNumber: string | null;
  currentUser: string | null;
  osType: 'windows' | 'mac' | 'linux';
  osVersion: string;
  ipAddress: string | null;
  macAddress: string | null;
  agentVersion: string;
}

export interface InstalledSoftware {
  name: string;
  version: string | null;
  installedAt: Date | null;
}

export interface HealthMetrics {
  cpuUsage: number; // percentage (overall CPU usage across all cores)
  cpuCores: number; // number of CPU cores
  ramUsage: number; // percentage
  diskUsage: number; // percentage (aggregate or primary drive)
  uptime: number; // seconds
  collectedAt: Date;
}

export interface PatchStatusReport {
  os: string;
  missingCritical: boolean;
  pendingUpdates: number;
  lastCheckedAt: Date;
  details: string | null;
}

export type DeviceLogSeverity = 'info' | 'warning' | 'error' | 'critical';

export interface DeviceLogItem {
  severity: DeviceLogSeverity;
  source: string;
  message: string;
  raw: string | null;
  collectedAt: Date;
}

export interface ProcessData {
  processName: string;
  pid: number | null;
  cpuUsage: number; // percentage
  ramUsage: number; // percentage
  command: string | null;
  collectedAt: Date;
}

export interface DeviceReport {
  deviceInfo: DeviceInfo;
  healthMetrics: HealthMetrics;
  softwareList?: InstalledSoftware[]; // Optional: undefined means never collected, empty array means no software installed
}

