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

export type ConnectedDeviceKind = 'usb' | 'bluetooth' | 'display' | 'printer' | 'network_neighbor';

export interface ConnectedDevice {
  kind: ConnectedDeviceKind;
  identifier: string;
  displayName: string;
  vendor: string | null;
  model: string | null;
  serialNumber: string | null;
  isConnected: boolean;
  metadata?: Record<string, unknown> | null;
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

export interface SecurityPostureReport {
  collectedAt: Date;
  antivirusInstalled: boolean;
  antivirusEnabled: boolean;
  antivirusUpToDate: boolean;
  antivirusProductName: string | null;
  firewallEnabled: boolean;
  firewallProfile: string | null;
  diskEncryptionEnabled: boolean;
  diskEncryptionMethod: string | null;
  diskEncryptionVolumes: Array<{ volume: string; encrypted: boolean }> | null;
  patchMissingCritical?: boolean | null;
  patchPendingUpdates?: number | null;
  patchLastCheckedAt?: Date | null;
  softwareHackedIndicatorsCount?: number | null;
  softwareMissingLicenseIndicatorsCount?: number | null;
  metadata?: Record<string, unknown> | null;
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

export interface SecurityEvent {
  eventId: string;
  eventType: string;
  severity: DeviceLogSeverity;
  source: string;
  message: string;
  collectedAt: Date;
  payload?: Record<string, unknown> | null;
}

export type ResponseActionType =
  | 'collect_diagnostics'
  | 'kill_process'
  | 'enable_firewall'
  | 'isolate_network'
  | 'restart_device';

export interface ResponseAction {
  id: number;
  actionType: ResponseActionType;
  requestedAt: Date;
  parameters?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
}

export interface ResponseActionExecutionResult {
  actionId: number;
  success: boolean;
  startedAt: Date;
  completedAt: Date;
  message: string;
  details?: Record<string, unknown> | null;
}

export interface DeviceReport {
  deviceInfo: DeviceInfo;
  healthMetrics: HealthMetrics;
  softwareList?: InstalledSoftware[]; // Optional: undefined means never collected, empty array means no software installed
  connectedDevices?: ConnectedDevice[]; // Optional: undefined means feature disabled/not collected
}

