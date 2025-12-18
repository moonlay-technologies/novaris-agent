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
  cpuUsage: number; // percentage
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

export interface DeviceReport {
  deviceInfo: DeviceInfo;
  healthMetrics: HealthMetrics;
  softwareList: InstalledSoftware[];
}

