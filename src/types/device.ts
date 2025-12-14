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

export interface DeviceReport {
  deviceInfo: DeviceInfo;
  healthMetrics: HealthMetrics;
  softwareList: InstalledSoftware[];
}

