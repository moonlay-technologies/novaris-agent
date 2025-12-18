import { AgentConfig } from '../types/config';
import { DeviceReport, PatchStatusReport } from '../types/device';
import { DeviceInfoCollector } from '../collectors/deviceInfoCollector';
import { SoftwareCollector } from '../collectors/softwareCollector';
import { HealthMetricsCollector } from '../collectors/healthMetricsCollector';
import { PatchStatusCollector } from '../collectors/patchStatusCollector';
import { ReportingService } from './reportingService';
import { getLogger } from '../utils/logger';
import { saveConfig } from '../utils/config';

export class AgentService {
  private deviceInfoCollector: DeviceInfoCollector;
  private softwareCollector: SoftwareCollector;
  private healthMetricsCollector: HealthMetricsCollector;
  private patchStatusCollector: PatchStatusCollector;
  private reportingService: ReportingService;
  private logger = getLogger();
  private collectInterval: NodeJS.Timeout | null = null;
  private reportInterval: NodeJS.Timeout | null = null;
  private patchStatusInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastDeviceInfo: DeviceReport['deviceInfo'] | null = null;
  private lastPatchStatusAt: Date | null = null;

  constructor(private config: AgentConfig) {
    this.deviceInfoCollector = new DeviceInfoCollector();
    this.softwareCollector = new SoftwareCollector();
    this.healthMetricsCollector = new HealthMetricsCollector();
    this.patchStatusCollector = new PatchStatusCollector();
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
      // Validate asset tag is provided
      if (!this.config.assetTag) {
        throw new Error('Asset Tag is required. Please set NOVARIS_ASSET_TAG environment variable or config.json');
      }

      // Initial device registration or lookup
      if (!this.config.deviceId) {
        await this.registerOrFindDevice();
      }

      // Start collecting and reporting
      this.startCollection();
      this.startReporting();
      this.startPatchStatusReporting();

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

    if (this.patchStatusInterval) {
      clearInterval(this.patchStatusInterval);
      this.patchStatusInterval = null;
    }

    // Process any remaining queued reports
    await this.reportingService.processQueue();

    this.logger.info('Novaris Agent stopped');
  }

  private async registerOrFindDevice(): Promise<void> {
    try {
      this.logger.info(`Looking up or registering device with asset tag: ${this.config.assetTag}`);
      
      // Step 1: Search for asset by asset tag
      const asset = await this.reportingService.findAssetByTag(this.config.assetTag);
      
      let assetId: number;
      
      if (!asset) {
        // Step 2: Asset not found, create it first
        this.logger.info(`Asset with tag ${this.config.assetTag} not found. Creating new asset...`);
        const deviceInfo = await this.deviceInfoCollector.collect();
        this.lastDeviceInfo = deviceInfo;
        
        assetId = await this.reportingService.createAsset(this.config.assetTag, deviceInfo);
        this.logger.info(`Asset created with ID: ${assetId} for tag: ${this.config.assetTag}`);
      } else {
        assetId = asset.id;
        this.logger.info(`Found existing asset with ID: ${assetId} for tag: ${this.config.assetTag}`);
        
        // If asset has a device linked, use it
        if (asset.deviceId) {
          this.logger.info(`Found existing device with ID: ${asset.deviceId} for asset tag: ${this.config.assetTag}`);
          this.config.deviceId = asset.deviceId;
          saveConfig({ deviceId: asset.deviceId });
          return;
        }
      }

      // Step 3: Register device (asset exists now, device will be linked to it)
      this.logger.info(`Registering device for asset ID: ${assetId}...`);
      const deviceInfo = await this.deviceInfoCollector.collect();
      this.lastDeviceInfo = deviceInfo;

      const deviceId = await this.reportingService.registerDevice(deviceInfo, this.config.assetTag);
      this.config.deviceId = deviceId;
      saveConfig({ deviceId });

      this.logger.info(`Device registered with ID: ${deviceId} for asset tag: ${this.config.assetTag}`);
    } catch (error) {
      this.logger.error('Device lookup/registration failed', { error });
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

  private startPatchStatusReporting(): void {
    if (!this.config.collectPatchStatus) {
      this.logger.info('Patch status collection disabled (collectPatchStatus=false)');
      return;
    }

    this.logger.info(`Starting patch status reporting (interval: ${this.config.patchStatusInterval}s)`);

    // Report immediately
    this.reportPatchStatus().catch((error) => {
      this.logger.error('Initial patch status report failed', { error });
    });

    // Then report at intervals
    this.patchStatusInterval = setInterval(() => {
      this.reportPatchStatus().catch((error) => {
        this.logger.error('Patch status report failed', { error });
      });
    }, this.config.patchStatusInterval * 1000);
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

      let softwareList: DeviceReport['softwareList'] = [];

      if (this.config.collectSoftware) {
        softwareList = await this.softwareCollector.collect();
      }

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

  private async reportPatchStatus(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping patch status report');
      return;
    }

    try {
      // Avoid frequent repeats if interval misconfigured too low
      if (this.lastPatchStatusAt) {
        const minGapSeconds = Math.min(this.config.patchStatusInterval, 300);
        const secondsSinceLast = (Date.now() - this.lastPatchStatusAt.getTime()) / 1000;
        if (secondsSinceLast < minGapSeconds) {
          return;
        }
      }

      const status: PatchStatusReport = await this.patchStatusCollector.collect();
      await this.reportingService.reportPatchStatus(this.config.deviceId, status);
      this.lastPatchStatusAt = new Date();
    } catch (error) {
      this.logger.error('Failed to report patch status', { error });
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

