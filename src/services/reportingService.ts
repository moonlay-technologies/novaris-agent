import axios, { AxiosInstance } from 'axios';
import { DeviceReport } from '../types/device';
import { AgentConfig } from '../types/config';
import { getLogger } from '../utils/logger';

export class ReportingService {
  private apiClient: AxiosInstance;
  private logger = getLogger();
  private reportQueue: DeviceReport[] = [];
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

  async registerDevice(deviceInfo: DeviceReport['deviceInfo']): Promise<number> {
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

        await this.apiClient.post(`/devices/${deviceId}/health`, payload);

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
    if (this.reportQueue.length === 0 || !this.isOnline || !this.config.deviceId) {
      return;
    }

    this.logger.info(`Processing ${this.reportQueue.length} queued reports...`);
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
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

