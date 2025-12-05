import { AgentConfig } from '../types/config';
import { DeviceReport } from '../types/device';
import { DeviceInfoCollector } from '../collectors/deviceInfoCollector';
import { SoftwareCollector } from '../collectors/softwareCollector';
import { HealthMetricsCollector } from '../collectors/healthMetricsCollector';
import { ReportingService } from './reportingService';
import { getLogger } from '../utils/logger';
import { saveConfig } from '../utils/config';

export class AgentService {
  private deviceInfoCollector: DeviceInfoCollector;
  private softwareCollector: SoftwareCollector;
  private healthMetricsCollector: HealthMetricsCollector;
  private reportingService: ReportingService;
  private logger = getLogger();
  private collectInterval: NodeJS.Timeout | null = null;
  private reportInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastDeviceInfo: DeviceReport['deviceInfo'] | null = null;

  constructor(private config: AgentConfig) {
    this.deviceInfoCollector = new DeviceInfoCollector();
    this.softwareCollector = new SoftwareCollector();
    this.healthMetricsCollector = new HealthMetricsCollector();
    this.reportingService = new ReportingService(config);
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Agent is already running');
      return;
    }

    this.logger.info('Starting Novaris Agent...');
    this.isRunning = true;

    try {
      // Initial device registration
      if (!this.config.deviceId) {
        await this.registerDevice();
      }

      // Start collecting and reporting
      this.startCollection();
      this.startReporting();

      this.logger.info('Novaris Agent started successfully');
    } catch (error) {
      this.logger.error('Failed to start agent', { error });
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Novaris Agent...');
    this.isRunning = false;

    if (this.collectInterval) {
      clearInterval(this.collectInterval);
      this.collectInterval = null;
    }

    if (this.reportInterval) {
      clearInterval(this.reportInterval);
      this.reportInterval = null;
    }

    // Process any remaining queued reports
    await this.reportingService.processQueue();

    this.logger.info('Novaris Agent stopped');
  }

  private async registerDevice(): Promise<void> {
    try {
      this.logger.info('Registering device with server...');
      const deviceInfo = await this.deviceInfoCollector.collect();
      this.lastDeviceInfo = deviceInfo;

      const deviceId = await this.reportingService.registerDevice(deviceInfo);
      this.config.deviceId = deviceId;
      saveConfig({ deviceId });

      this.logger.info(`Device registered with ID: ${deviceId}`);
    } catch (error) {
      this.logger.error('Device registration failed', { error });
      throw error;
    }
  }

  private startCollection(): void {
    this.logger.info(`Starting data collection (interval: ${this.config.collectInterval}s)`);
    
    // Collect immediately
    this.collectData().catch((error) => {
      this.logger.error('Initial data collection failed', { error });
    });

    // Then collect at intervals
    this.collectInterval = setInterval(() => {
      this.collectData().catch((error) => {
        this.logger.error('Data collection failed', { error });
      });
    }, this.config.collectInterval * 1000);
  }

  private startReporting(): void {
    this.logger.info(`Starting health reporting (interval: ${this.config.reportInterval}s)`);
    
    // Report immediately
    this.reportData().catch((error) => {
      this.logger.error('Initial health report failed', { error });
    });

    // Then report at intervals
    this.reportInterval = setInterval(() => {
      this.reportData().catch((error) => {
        this.logger.error('Health report failed', { error });
      });
    }, this.config.reportInterval * 1000);
  }

  private async collectData(): Promise<void> {
    try {
      this.logger.debug('Collecting device data...');

      // Collect device info (only if not already collected or if changed)
      if (!this.lastDeviceInfo) {
        this.lastDeviceInfo = await this.deviceInfoCollector.collect();
      }

      // Note: Device info doesn't change frequently, so we don't need to collect it every time
      // Software list also doesn't change frequently
    } catch (error) {
      this.logger.error('Failed to collect device data', { error });
      throw error;
    }
  }

  private async reportData(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping report');
      return;
    }

    try {
      this.logger.debug('Collecting health metrics and preparing report...');

      // Collect health metrics (these change frequently)
      const healthMetrics = await this.healthMetricsCollector.collect();

      // Collect software list (only occasionally, not every report)
      // For now, we'll collect it less frequently
      let softwareList: DeviceReport['softwareList'] = [];
      const shouldCollectSoftware = Math.random() < 0.1; // 10% chance each report
      if (shouldCollectSoftware) {
        softwareList = await this.softwareCollector.collect();
      }

      // Ensure we have device info
      if (!this.lastDeviceInfo) {
        this.lastDeviceInfo = await this.deviceInfoCollector.collect();
      }

      const report: DeviceReport = {
        deviceInfo: this.lastDeviceInfo,
        healthMetrics,
        softwareList,
      };

      await this.reportingService.reportHealth(this.config.deviceId, report);
    } catch (error) {
      this.logger.error('Failed to report data', { error });
      throw error;
    }
  }

  async collectFullReport(): Promise<DeviceReport> {
    this.logger.info('Collecting full device report...');

    const deviceInfo = await this.deviceInfoCollector.collect();
    const softwareList = await this.softwareCollector.collect();
    const healthMetrics = await this.healthMetricsCollector.collect();

    this.lastDeviceInfo = deviceInfo;

    return {
      deviceInfo,
      healthMetrics,
      softwareList,
    };
  }
}

