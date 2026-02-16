import axios, { AxiosInstance } from 'axios';
import { DeviceLogItem, DeviceReport, PatchStatusReport, ProcessData } from '../types/device';
import { AgentConfig } from '../types/config';
import { getLogger } from '../utils/logger';

export class ReportingService {
  private apiClient: AxiosInstance;
  private logger = getLogger();
  private reportQueue: DeviceReport[] = [];
  private patchStatusQueue: PatchStatusReport[] = [];
  private logsQueue: DeviceLogItem[][] = [];
  private processesQueue: ProcessData[][] = [];
  private isOnline: boolean = true;
  private nextOnlineCheckAt: number | null = null;

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

  private shouldAttemptOnline(): boolean {
    if (this.isOnline) {
      return true;
    }

    if (this.nextOnlineCheckAt === null) {
      return true;
    }

    if (!Number.isFinite(this.nextOnlineCheckAt)) {
      this.nextOnlineCheckAt = Date.now() + this.getRetryDelayMs();
      return true;
    }

    return Date.now() >= this.nextOnlineCheckAt;
  }

  private markOffline(reason: string): void {
    if (this.isOnline) {
      this.logger.warn(`Network appears offline: ${reason}`);
    }

    this.isOnline = false;
    this.nextOnlineCheckAt = Date.now() + this.getRetryDelayMs();
  }

  private markOnline(): void {
    if (!this.isOnline) {
      this.logger.info('Network restored, resuming reporting');
    }

    this.isOnline = true;
    this.nextOnlineCheckAt = null;
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

        this.markOnline();
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
          this.markOffline('asset search failed');
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
          const delay = this.getBackoffDelay(attempt);
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

        this.markOnline();
        this.logger.info(`Asset created successfully with ID: ${asset.id}`);
        return asset.id;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        
        if (isNetworkError) {
          this.markOffline('asset creation failed');
          this.logger.warn(`Network error during asset creation (attempt ${attempt + 1}/${maxRetries})`);
        } else {
          this.logger.error(`Asset creation failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.getBackoffDelay(attempt);
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
          agent_version: deviceInfo.agentVersion,
          ip_address: deviceInfo.ipAddress,
          mac_address: deviceInfo.macAddress,
          asset_tag: assetTag, // Include asset tag in registration
        });

        const deviceId = response.data?.data?.id || response.data?.id;
        if (deviceId) {
          this.markOnline();
          this.logger.info(`Device registered successfully with ID: ${deviceId}`);
          return deviceId;
        }

        throw new Error('Device ID not found in response');
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        
        if (isNetworkError) {
          this.markOffline('device registration failed');
          this.logger.warn(`Network error during registration (attempt ${attempt + 1}/${maxRetries})`);
        } else {
          this.logger.error(`Registration failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.getBackoffDelay(attempt); // Exponential backoff
          this.logger.info(`Retrying in ${delay}ms...`);
          await this.sleep(delay);
        }
      }
    }

    throw lastError || new Error('Failed to register device after all retries');
  }

  async reportHealth(deviceId: number, report: DeviceReport): Promise<void> {
    if (!this.shouldAttemptOnline()) {
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
          cpu_cores: report.healthMetrics.cpuCores,
          ram_usage: report.healthMetrics.ramUsage,
          disk_usage: report.healthMetrics.diskUsage,
          uptime: report.healthMetrics.uptime,
          collected_at: report.healthMetrics.collectedAt.toISOString(),
          agent_version: report.deviceInfo.agentVersion, // Include agent version with every health report
        };

        const response = await this.apiClient.post(`/devices/${deviceId}/health`, payload);

        this.markOnline();

        // Also sync software list if provided (even if empty, to handle uninstalled software)
        // Only skip if softwareList is undefined (not collected) vs empty array (all uninstalled)
        if (report.softwareList !== undefined) {
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
          this.markOffline('health report failed');
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
          const delay = this.getBackoffDelay(attempt);
          await this.sleep(delay);
        }
      }
    }

    // If all retries failed, queue the report
    this.logger.warn('Failed to send health report after all retries, queuing for later');
    this.reportQueue.push(report);
  }

  async reportPatchStatus(deviceId: number, status: PatchStatusReport): Promise<void> {
    if (!this.shouldAttemptOnline()) {
      this.logger.warn('Device is offline, queuing patch status');
      this.patchStatusQueue.push(status);
      return;
    }

    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Reporting patch status (attempt ${attempt + 1}/${maxRetries})...`);

        const payload: any = {
          os: status.os,
          missing_critical: status.missingCritical,
          pending_updates: status.pendingUpdates,
          last_checked_at: status.lastCheckedAt.toISOString(),
        };

        // Only include details if it's a non-empty string
        if (status.details && status.details.trim()) {
          payload.details = status.details;
        }

        await this.apiClient.post(`/devices/${deviceId}/patch-status`, payload);
        this.markOnline();
        this.logger.debug('Patch status report sent successfully');
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';

        if (isNetworkError) {
          this.markOffline('patch status report failed');
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
          const delay = this.getBackoffDelay(attempt);
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

    if (!this.shouldAttemptOnline()) {
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
          logs: logs.map((l) => {
            const logEntry: any = {
              severity: l.severity,
              source: l.source,
              message: l.message,
              collected_at: l.collectedAt.toISOString(),
            };

            // Only include raw field if it has a value
            if (l.raw !== null) {
              logEntry.raw = l.raw;
            }

            return logEntry;
          }),
        };
        await this.apiClient.post(`/devices/${deviceId}/logs`, payload);
        this.markOnline();
        this.logger.debug('Device logs sent successfully');
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';

        if (isNetworkError) {
          this.markOffline('device logs report failed');
          this.logger.warn(`Network error during device logs report (attempt ${attempt + 1}/${maxRetries})`);
          this.logsQueue.push(logs);
          return;
        } else {
          this.logger.error(`Device logs report failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
            response: error.response?.data,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.getBackoffDelay(attempt);
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

  async reportProcesses(deviceId: number, processes: ProcessData[]): Promise<void> {
    if (!processes.length) return;

    if (!this.shouldAttemptOnline()) {
      this.logger.warn('Device is offline, queuing processes');
      this.processesQueue.push(processes);
      return;
    }

    const maxRetries = this.config.retryAttempts;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        this.logger.debug(`Reporting processes (attempt ${attempt + 1}/${maxRetries})...`);

        const payload = {
          collected_at: processes[0]?.collectedAt.toISOString() || new Date().toISOString(),
          processes: processes.map((p) => ({
            process_name: p.processName.substring(0, 255),
            pid: p.pid !== null ? p.pid : undefined,
            cpu_usage: p.cpuUsage,
            ram_usage: p.ramUsage,
            command: p.command !== null ? p.command.substring(0, 2000) : undefined,
          })),
        };
        await this.apiClient.post(`/devices/${deviceId}/processes`, payload);
        this.markOnline();
        this.logger.debug('Processes sent successfully');
        return;
      } catch (error: any) {
        lastError = error;
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';

        if (isNetworkError) {
          this.markOffline('processes report failed');
          this.logger.warn(`Network error during processes report (attempt ${attempt + 1}/${maxRetries})`);
          this.processesQueue.push(processes);
          return;
        } else {
          this.logger.error(`Processes report failed (attempt ${attempt + 1}/${maxRetries})`, {
            status: error.response?.status,
            message: error.response?.data?.error || error.message,
            response: error.response?.data,
          });
        }

        if (attempt < maxRetries - 1) {
          const delay = this.getBackoffDelay(attempt);
          await this.sleep(delay);
        }
      }
    }

    this.logger.warn('Failed to send processes after all retries, queuing for later');
    this.processesQueue.push(processes);
    if (lastError) {
      this.logger.debug('Last processes error', { error: lastError.message });
    }
  }

  private async syncSoftwareList(deviceId: number, softwareList: DeviceReport['softwareList']): Promise<void> {
    // Send entire software list in one bulk request
    // Backend will handle insert/update/delete and trigger policy evaluation
    
    // Handle undefined or empty software list
    if (!softwareList || softwareList.length === 0) {
      this.logger.debug('No software list to sync (empty or undefined)');
      return;
    }
    
    try {
      await this.apiClient.post(`/devices/${deviceId}/software/sync`, {
        software_list: softwareList.map(software => ({
          software_name: software.name,
          version: software.version || undefined,
          installed_at: software.installedAt?.toISOString(),
        })),
      });
      this.logger.debug(`Synced ${softwareList.length} software items via bulk sync`);
    } catch (error: any) {
      this.logger.error(`Failed to sync software list`, { 
        error: error.message,
        deviceId,
        softwareCount: softwareList.length 
      });
      throw error;
    }
  }

  async processQueue(): Promise<void> {
    if (
      (!this.reportQueue.length && !this.patchStatusQueue.length && !this.logsQueue.length && !this.processesQueue.length) ||
      !this.config.deviceId
    ) {
      return;
    }

    if (!this.shouldAttemptOnline()) {
      return;
    }

    this.logger.info(
      `Processing queued reports... health=${this.reportQueue.length}, patch_status=${this.patchStatusQueue.length}, logs=${this.logsQueue.length}, processes=${this.processesQueue.length}`
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

    const processBatches = [...this.processesQueue];
    this.processesQueue = [];
    for (const batch of processBatches) {
      try {
        await this.reportProcesses(this.config.deviceId!, batch);
      } catch (error) {
        this.logger.error('Failed to process queued processes', { error });
        this.processesQueue.push(batch);
      }
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public getOnlineStatus(): boolean {
    return this.isOnline;
  }

  private getRetryDelayMs(): number {
    const delay = Number(this.config.retryDelay);
    if (!Number.isFinite(delay) || delay < 0) {
      return 1000;
    }
    return delay;
  }

  private getBackoffDelay(attempt: number): number {
    const baseDelay = this.getRetryDelayMs();
    return baseDelay * Math.pow(2, attempt);
  }
}

