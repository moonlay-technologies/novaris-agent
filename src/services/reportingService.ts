import axios, { AxiosInstance } from 'axios';
import { DeviceLogItem, DeviceReport, PatchStatusReport } from '../types/device';
import { AgentConfig } from '../types/config';
import { getLogger } from '../utils/logger';

export class ReportingService {
  private apiClient: AxiosInstance;
  private logger = getLogger();
  private reportQueue: DeviceReport[] = [];
  private patchStatusQueue: PatchStatusReport[] = [];
  private logsQueue: DeviceLogItem[][] = [];
  private isOnline: boolean = true;

  constructor(private config: AgentConfig) {
    this.apiClient = axios.create({
      baseURL: config.apiUrl,
      timeout: 30000,
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
    });

    // Monitor online/offline status (Node.js environment)
    // Offline status is detected by failed network requests
  }

  async findAssetByTag(assetTag: string): Promise<{ id: number; deviceId?: number } | null> {
    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Searching for asset by tag: ${assetTag} (attempt ${attempt + 1}/${maxRetries})...`);
        
        const response = await this.apiClient.get(`/assets/by-tag/${encodeURIComponent(assetTag)}`);
        
        const asset = response.data?.data;
        if (!asset) {
          this.logger.debug(`Asset with tag ${assetTag} not found`);
          return null;
        }

        this.logger.info(`Found asset with ID: ${asset.id} for tag: ${assetTag}`);
        
        // Check if asset has a device linked (device_id might be in the response)
        return {
          id: asset.id,
          deviceId: asset.device_id || undefined,
        };
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        
        if (isNetworkError) {
          this.isOnline = false;
          this.logger.warn(`Network error during asset search (attempt ${attempt + 1}/${maxRetries})`);
        } else if (error.response?.status === 404) {
          // Asset not found is not an error, just return null
          this.logger.debug(`Asset with tag ${assetTag} not found`);
          return null;
        } else {
          this.logger.error(`Asset search failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1 && error.response?.status !== 404) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          this.logger.info(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    // If all retries failed and it wasn't a 404, throw error
    if (lastError && lastError.message && !lastError.message.includes('404')) {
      throw lastError;
    }

    return null;
  }

  async createAsset(assetTag: string, deviceInfo: DeviceReport['deviceInfo']): Promise<number> {
    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.info(`Creating asset with tag: ${assetTag} (attempt ${attempt + 1}/${maxRetries})...`);
        
        const response = await this.apiClient.post('/assets/register', {
          asset_tag: assetTag,
          serial_number: deviceInfo.serialNumber,
          name: `${deviceInfo.hostname} (Auto-created)`,
        });

        const asset = response.data?.data;
        if (!asset || !asset.id) {
          throw new Error('Asset ID not found in response');
        }

        this.logger.info(`Asset created successfully with ID: ${asset.id}`);
        return asset.id;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        
        if (isNetworkError) {
          this.isOnline = false;
          this.logger.warn(`Network error during asset creation (attempt ${attempt + 1}/${maxRetries})`);
        } else {
          this.logger.error(`Asset creation failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          this.logger.info(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Failed to create asset after all retries');
  }

  async findDeviceByAssetTag(assetTag: string): Promise<number | null> {
    // First, search for asset by tag
    const asset = await this.findAssetByTag(assetTag);
    
    if (!asset) {
      // Asset not found, will need to create it
      return null;
    }

    // If asset has a device linked, return device ID
    if (asset.deviceId) {
      this.logger.info(`Found device ID: ${asset.deviceId} for asset tag: ${assetTag}`);
      return asset.deviceId;
    }

    // Asset exists but no device linked
    this.logger.debug(`Asset found but no device linked. Asset ID: ${asset.id}`);
    return null;
  }

  async registerDevice(deviceInfo: DeviceReport['deviceInfo'], assetTag: string): Promise<number> {
    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.info(`Registering device (attempt ${attempt + 1}/${maxRetries})...`);
        
        const response = await this.apiClient.post('/devices/register', {
          hostname: deviceInfo.hostname,
          serial_number: deviceInfo.serialNumber,
          os_type: deviceInfo.osType,
          os_version: deviceInfo.osVersion,
          ip_address: deviceInfo.ipAddress,
          mac_address: deviceInfo.macAddress,
          asset_tag: assetTag, // Include asset tag in registration
        });

        const deviceId = response.data?.data?.id || response.data?.id;
        if (deviceId) {
          this.logger.info(`Device registered successfully with ID: ${deviceId}`);
          return deviceId;
        }

        throw new Error('Device ID not found in response');
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        
        if (isNetworkError) {
          this.isOnline = false;
          this.logger.warn(`Network error during registration (attempt ${attempt + 1}/${maxRetries})`);
        } else {
          this.logger.error(`Registration failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt); // Exponential backoff
          this.logger.info(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Failed to register device after all retries');
  }

  async reportHealth(deviceId: number, report: DeviceReport): Promise<void> {
    if (!this.isOnline) {
      this.logger.warn('Device is offline, queuing report');
      this.reportQueue.push(report);
      return;
    }

    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Reporting health metrics (attempt ${attempt + 1}/${maxRetries})...`);

        const payload = {
          cpu_usage: report.healthMetrics.cpuUsage,
          ram_usage: report.healthMetrics.ramUsage,
          disk_usage: report.healthMetrics.diskUsage,
          uptime: report.healthMetrics.uptime,
          collected_at: report.healthMetrics.collectedAt.toISOString(),
        };

        const response = await this.apiClient.post(`/devices/${deviceId}/health`, payload);

        // Also sync software list if provided
        if (report.softwareList && report.softwareList.length > 0) {
          try {
            await this.syncSoftwareList(deviceId, report.softwareList);
          } catch (error) {
            this.logger.warn('Failed to sync software list', { error });
          }
        }

        this.logger.debug('Health report sent successfully');
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        
        if (isNetworkError) {
          this.isOnline = false;
          this.logger.warn(`Network error during health report (attempt ${attempt + 1}/${maxRetries})`);
          this.reportQueue.push(report);
          return;
        } else {
          this.logger.error(`Health report failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    // If all retries failed, queue the report
    this.logger.warn('Failed to send health report after all retries, queuing for later');
    this.reportQueue.push(report);
  }

  async reportPatchStatus(deviceId: number, status: PatchStatusReport): Promise<void> {
    if (!this.isOnline) {
      this.logger.warn('Device is offline, queuing patch status');
      this.patchStatusQueue.push(status);
      return;
    }

    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Reporting patch status (attempt ${attempt + 1}/${maxRetries})...`);

        const payload = {
          os: status.os,
          missing_critical: status.missingCritical,
          pending_updates: status.pendingUpdates,
          last_checked_at: status.lastCheckedAt.toISOString(),
          details: status.details ?? undefined,
        };

        await this.apiClient.post(`/devices/${deviceId}/patch-status`, payload);
        this.logger.debug('Patch status report sent successfully');
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';

        if (isNetworkError) {
          this.isOnline = false;
          this.logger.warn(`Network error during patch status report (attempt ${attempt + 1}/${maxRetries})`);
          this.patchStatusQueue.push(status);
          return;
        } else {
          this.logger.error(`Patch status report failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    this.logger.warn('Failed to send patch status after all retries, queuing for later');
    this.patchStatusQueue.push(status);
    if (lastError) {
      this.logger.debug('Last patch status error', { error: lastError.message });
    }
  }

  async reportDeviceLogs(deviceId: number, logs: DeviceLogItem[]): Promise<void> {
    if (!logs.length) return;

    if (!this.isOnline) {
      this.logger.warn('Device is offline, queuing device logs');
      this.logsQueue.push(logs);
      return;
    }

    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Reporting device logs (attempt ${attempt + 1}/${maxRetries})...`);

        const payload = {
          logs: logs.map((l) => ({
            severity: l.severity,
            source: l.source,
            message: l.message,
            raw: l.raw ?? undefined,
            collected_at: l.collectedAt.toISOString(),
          })),
        };

        await this.apiClient.post(`/devices/${deviceId}/logs`, payload);
        this.logger.debug('Device logs sent successfully');
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';

        if (isNetworkError) {
          this.isOnline = false;
          this.logger.warn(`Network error during device logs report (attempt ${attempt + 1}/${maxRetries})`);
          this.logsQueue.push(logs);
          return;
        } else {
          this.logger.error(`Device logs report failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await this.sleep(delay);
        }
      }
    }

    this.logger.warn('Failed to send device logs after all retries, queuing for later');
    this.logsQueue.push(logs);
    if (lastError) {
      this.logger.debug('Last device logs error', { error: lastError.message });
    }
  }

  private async syncSoftwareList(deviceId: number, softwareList: DeviceReport['softwareList']): Promise<void> {
    for (const software of softwareList) {
      try {
        await this.apiClient.post(`/devices/${deviceId}/software`, {
          software_name: software.name,
          version: software.version,
          installed_at: software.installedAt?.toISOString(),
        });
      } catch (error: any) {
        // Ignore individual software sync errors
        this.logger.debug(`Failed to sync software: ${software.name}`, { error: error.message });
      }
    }
  }

  async processQueue(): Promise<void> {
    if (
      (!this.reportQueue.length && !this.patchStatusQueue.length && !this.logsQueue.length) ||
      !this.isOnline ||
      !this.config.deviceId
    ) {
      return;
    }

    this.logger.info(
      `Processing queued reports... health=${this.reportQueue.length}, patch_status=${this.patchStatusQueue.length}, logs=${this.logsQueue.length}`
    );

    const reports = [...this.reportQueue];
    this.reportQueue = [];

    for (const report of reports) {
      try {
        await this.reportHealth(this.config.deviceId!, report);
      } catch (error) {
        this.logger.error('Failed to process queued report', { error });
        // Re-queue if it fails
        this.reportQueue.push(report);
      }
    }

    const patchStatuses = [...this.patchStatusQueue];
    this.patchStatusQueue = [];
    for (const status of patchStatuses) {
      try {
        await this.reportPatchStatus(this.config.deviceId!, status);
      } catch (error) {
        this.logger.error('Failed to process queued patch status', { error });
        this.patchStatusQueue.push(status);
      }
    }

    const logBatches = [...this.logsQueue];
    this.logsQueue = [];
    for (const batch of logBatches) {
      try {
        await this.reportDeviceLogs(this.config.deviceId!, batch);
      } catch (error) {
        this.logger.error('Failed to process queued device logs', { error });
        this.logsQueue.push(batch);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

