import { AgentConfig } from '../types/config';
import {
  DeviceLogItem,
  DeviceReport,
  PatchStatusReport,
  SecurityEvent,
  SecurityPostureReport,
} from '../types/device';
import { DeviceInfoCollector } from '../collectors/deviceInfoCollector';
import { SoftwareCollector } from '../collectors/softwareCollector';
import { HealthMetricsCollector } from '../collectors/healthMetricsCollector';
import { PatchStatusCollector } from '../collectors/patchStatusCollector';
import { SecurityPostureCollector } from '../collectors/securityPostureCollector';
import { LogCollector } from '../collectors/logCollector';
import { ProcessCollector } from '../collectors/processCollector';
import { ConnectedDevicesCollector } from '../collectors/connectedDevicesCollector';
import { SoftwareRiskAssessment, SoftwareRiskCollector } from '../collectors/softwareRiskCollector';
import { ReportingService } from './reportingService';
import { SecurityEventNormalizer } from './securityEventNormalizer';
import { ResponseActionService } from './responseActionService';
import { getLogger } from '../utils/logger';
import { saveConfig } from '../utils/config';

export class AgentService {
  private static readonly PATCH_DETAILS_MAX_CHARS = 6000;

  private deviceInfoCollector: DeviceInfoCollector;
  private softwareCollector: SoftwareCollector;
  private healthMetricsCollector: HealthMetricsCollector;
  private patchStatusCollector: PatchStatusCollector;
  private securityPostureCollector: SecurityPostureCollector;
  private logCollector: LogCollector;
  private processCollector: ProcessCollector;
  private connectedDevicesCollector: ConnectedDevicesCollector;
  private softwareRiskCollector: SoftwareRiskCollector;
  private reportingService: ReportingService;
  private securityEventNormalizer: SecurityEventNormalizer;
  private responseActionService: ResponseActionService;
  private logger = getLogger();
  private collectInterval: NodeJS.Timeout | null = null;
  private reportInterval: NodeJS.Timeout | null = null;
  private patchStatusInterval: NodeJS.Timeout | null = null;
  private securityPostureInterval: NodeJS.Timeout | null = null;
  private logsInterval: NodeJS.Timeout | null = null;
  private processInterval: NodeJS.Timeout | null = null;
  private queueInterval: NodeJS.Timeout | null = null;
  private responseActionsInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastDeviceInfo: DeviceReport['deviceInfo'] | null = null;
  private lastPatchStatusAt: Date | null = null;
  private lastPatchStatus: PatchStatusReport | null = null;
  private lastLogsCursorAt: Date | null = null;
  private softwareCollectionIteration: number = 0;
  private lastSoftwareList: DeviceReport['softwareList'] | undefined = undefined;
  private lastSoftwareRiskAssessment: SoftwareRiskAssessment | null = null;

  constructor(private config: AgentConfig) {
    this.deviceInfoCollector = new DeviceInfoCollector();
    this.softwareCollector = new SoftwareCollector();
    this.healthMetricsCollector = new HealthMetricsCollector();
    this.patchStatusCollector = new PatchStatusCollector();
    this.securityPostureCollector = new SecurityPostureCollector();
    this.logCollector = new LogCollector();
    this.processCollector = new ProcessCollector();
    this.connectedDevicesCollector = new ConnectedDevicesCollector({
      includeNetworkNeighbors: config.collectNetworkNeighbors,
    });
    this.softwareRiskCollector = new SoftwareRiskCollector();
    this.reportingService = new ReportingService(config);
    this.securityEventNormalizer = new SecurityEventNormalizer();
    this.responseActionService = new ResponseActionService(config);
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
      this.startSecurityPostureReporting();
      this.startLogsReporting();
      this.startProcessReporting();
      this.startResponseActionsPolling();
      this.startQueueProcessing();

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

    if (this.securityPostureInterval) {
      clearInterval(this.securityPostureInterval);
      this.securityPostureInterval = null;
    }

    if (this.logsInterval) {
      clearInterval(this.logsInterval);
      this.logsInterval = null;
    }

    if (this.processInterval) {
      clearInterval(this.processInterval);
      this.processInterval = null;
    }

    if (this.responseActionsInterval) {
      clearInterval(this.responseActionsInterval);
      this.responseActionsInterval = null;
    }

    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
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

  private startSecurityPostureReporting(): void {
    if (!this.config.collectSecurityPosture) {
      this.logger.info('Security posture collection disabled (collectSecurityPosture=false)');
      return;
    }

    this.logger.info(`Starting security posture reporting (interval: ${this.config.securityPostureInterval}s)`);

    this.reportSecurityPosture().catch((error) => {
      this.logger.error('Initial security posture report failed', { error });
    });

    this.securityPostureInterval = setInterval(() => {
      this.reportSecurityPosture().catch((error) => {
        this.logger.error('Security posture report failed', { error });
      });
    }, this.config.securityPostureInterval * 1000);
  }

  private startLogsReporting(): void {
    if (!this.config.collectLogs) {
      this.logger.info('Log collection disabled (collectLogs=false)');
      return;
    }

    this.logger.info(`Starting log reporting (interval: ${this.config.logsInterval}s)`);

    // restore cursor from config if available
    if (this.config.logsCursor?.last_collected_at) {
      const parsed = new Date(this.config.logsCursor.last_collected_at);
      if (!Number.isNaN(parsed.getTime())) {
        this.lastLogsCursorAt = parsed;
      }
    }

    // Collect immediately
    this.reportLogs().catch((error) => {
      this.logger.error('Initial log report failed', { error });
    });

    // Then collect at intervals
    this.logsInterval = setInterval(() => {
      this.reportLogs().catch((error) => {
        this.logger.error('Log report failed', { error });
      });
    }, this.config.logsInterval * 1000);
  }

  private startProcessReporting(): void {
    if (!this.config.collectProcesses) {
      this.logger.info('Process collection disabled (collectProcesses=false)');
      return;
    }

    this.logger.info(`Starting process reporting (interval: ${this.config.processInterval}s)`);

    // Report immediately
    this.reportProcesses().catch((error) => {
      this.logger.error('Initial process report failed', { error });
    });

    // Then report at intervals
    this.processInterval = setInterval(() => {
      this.reportProcesses().catch((error) => {
        this.logger.error('Process report failed', { error });
      });
    }, this.config.processInterval * 1000);
  }

  private startResponseActionsPolling(): void {
    if (!this.config.pollResponseActions) {
      this.logger.info('Response actions polling disabled (pollResponseActions=false)');
      return;
    }

    this.logger.info(`Starting response actions polling (interval: ${this.config.responseActionsInterval}s)`);

    this.pollResponseActions().catch((error) => {
      this.logger.error('Initial response actions polling failed', { error });
    });

    this.responseActionsInterval = setInterval(() => {
      this.pollResponseActions().catch((error) => {
        this.logger.error('Response actions polling failed', { error });
      });
    }, this.config.responseActionsInterval * 1000);
  }

  private startQueueProcessing(): void {
    const intervalSeconds = Math.max(30, this.config.reportInterval);
    this.logger.info(`Starting queue processing (interval: ${intervalSeconds}s)`);

    // Process immediately
    this.reportingService.processQueue().catch((error) => {
      this.logger.error('Initial queue processing failed', { error });
    });

    this.queueInterval = setInterval(() => {
      this.reportingService.processQueue().catch((error) => {
        this.logger.error('Queue processing failed', { error });
      });
    }, intervalSeconds * 1000);
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

      let softwareList: DeviceReport['softwareList'] | undefined = this.lastSoftwareList;
      let connectedDevices: DeviceReport['connectedDevices'] | undefined = undefined;

      // Increment software collection iteration counter
      this.softwareCollectionIteration++;

      // Collect software on first iteration or every N iterations to reduce frequency (configurable)
      const shouldCollectSoftware = this.config.collectSoftware && (
        this.softwareCollectionIteration === 1 || // First collection
        this.softwareCollectionIteration % this.config.softwareCollectionInterval === 0
      );

      if (shouldCollectSoftware) {
        this.logger.info(`Collecting software data (iteration: ${this.softwareCollectionIteration})`);
        softwareList = await this.softwareCollector.collect();
        this.lastSoftwareList = softwareList; // Cache the collected software list
        this.lastSoftwareRiskAssessment = this.softwareRiskCollector.collect(softwareList || []);
      } else if (this.config.collectSoftware && this.lastSoftwareList !== undefined) {
        const nextCollection = Math.ceil(this.softwareCollectionIteration / this.config.softwareCollectionInterval) * this.config.softwareCollectionInterval;
        this.logger.debug(`Using cached software data (iteration: ${this.softwareCollectionIteration}, ${softwareList?.length || 0} items, next collection at iteration ${nextCollection})`);
      }

      if (this.config.collectConnectedDevices) {
        connectedDevices = await this.connectedDevicesCollector.collect();
      }

      if (!this.lastDeviceInfo) {
        this.lastDeviceInfo = await this.deviceInfoCollector.collect();
      }

      const report: DeviceReport = {
        deviceInfo: this.lastDeviceInfo,
        healthMetrics,
        softwareList,
        connectedDevices,
      };

      await this.reportingService.reportHealth(this.config.deviceId, report);
    } catch (error: any) {
      this.logger.error('Failed to report data', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
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

      if (this.lastSoftwareRiskAssessment && this.lastSoftwareList && this.lastSoftwareList.length > 0) {
        status.details = this.mergePatchAndSoftwareRiskDetails(status.details, this.lastSoftwareRiskAssessment);
      }

      await this.reportingService.reportPatchStatus(this.config.deviceId, status);
      this.lastPatchStatusAt = new Date();
      this.lastPatchStatus = status;
    } catch (error: any) {
      this.logger.error('Failed to report patch status', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    }
  }

  private async reportLogs(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping log report');
      return;
    }

    try {
      const since = this.lastLogsCursorAt ? new Date(this.lastLogsCursorAt.getTime() - 5000) : undefined; // small overlap

      const { logs, cursor } = await this.logCollector.collect({
        since,
        maxItems: this.config.logsMaxBatchSize,
        minSeverity: this.config.logsMinSeverity,
        includeRaw: this.config.logsIncludeRaw,
      });

      // De-dup within batch (overlap)
      const deduped = this.dedupeLogs(logs);

      if (deduped.length > 0) {
        await this.reportingService.reportDeviceLogs(this.config.deviceId, deduped);

        if (this.config.collectSecurityEvents) {
          const events = this.filterSecurityEventsBySeverity(this.securityEventNormalizer.normalize(deduped));
          if (events.length > 0) {
            await this.reportingService.reportSecurityEvents(this.config.deviceId, events);
          }
        }
      }

      this.lastLogsCursorAt = cursor;
      // persist cursor so restarts don't resend from scratch
      this.config.logsCursor = { last_collected_at: cursor.toISOString() };
      saveConfig({ logsCursor: this.config.logsCursor });
    } catch (error: any) {
      console.log(error);
      this.logger.error('Failed to report logs', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message || error.toString(),
        response: error.response?.data,
        error
      });
      throw error;
    }
  }

  private async reportSecurityPosture(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping security posture report');
      return;
    }

    try {
      const posture: SecurityPostureReport = await this.securityPostureCollector.collect();

      if (this.lastPatchStatus) {
        posture.patchMissingCritical = this.lastPatchStatus.missingCritical;
        posture.patchPendingUpdates = this.lastPatchStatus.pendingUpdates;
        posture.patchLastCheckedAt = this.lastPatchStatus.lastCheckedAt;
      }

      if (this.lastSoftwareRiskAssessment) {
        posture.softwareHackedIndicatorsCount = this.lastSoftwareRiskAssessment.hackedIndicators.length;
        posture.softwareMissingLicenseIndicatorsCount =
          this.lastSoftwareRiskAssessment.missingLicenseIndicators.length;

        posture.metadata = {
          ...(posture.metadata ?? {}),
          software_risk: {
            checked_at: this.lastSoftwareRiskAssessment.checkedAt.toISOString(),
            hacked_indicators_count: this.lastSoftwareRiskAssessment.hackedIndicators.length,
            missing_license_indicators_count: this.lastSoftwareRiskAssessment.missingLicenseIndicators.length,
            hacked_indicators_sample: this.lastSoftwareRiskAssessment.hackedIndicators.slice(0, 10),
            missing_license_indicators_sample: this.lastSoftwareRiskAssessment.missingLicenseIndicators.slice(0, 10),
          },
        };
      }

      await this.reportingService.reportSecurityPosture(this.config.deviceId, posture);
    } catch (error: any) {
      this.logger.error('Failed to report security posture', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    }
  }

  private async reportProcesses(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping process report');
      return;
    }

    try {
      const processes = await this.processCollector.collect();
      
      if (processes.length > 0) {
        await this.reportingService.reportProcesses(this.config.deviceId, processes);
      }
    } catch (error: any) {
      this.logger.error('Failed to report processes', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    }
  }

  private async pollResponseActions(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping response actions polling');
      return;
    }

    try {
      await this.responseActionService.processPendingActions(this.config.deviceId);
    } catch (error: any) {
      this.logger.error('Failed to process response actions', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error,
      });
      throw error;
    }
  }

  private dedupeLogs(logs: DeviceLogItem[]): DeviceLogItem[] {
    const seen = new Set<string>();
    const out: DeviceLogItem[] = [];
    for (const l of logs) {
      // Ensure date is valid before using toISOString
      const dateStr = !isNaN(l.collectedAt.getTime()) ? l.collectedAt.toISOString() : new Date().toISOString();
      const key = `${l.source}|${l.severity}|${dateStr}|${l.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(l);
    }
    return out;
  }

  private filterSecurityEventsBySeverity(events: SecurityEvent[]): SecurityEvent[] {
    const rank = (severity: SecurityEvent['severity']): number => {
      switch (severity) {
        case 'critical':
          return 4;
        case 'error':
          return 3;
        case 'warning':
          return 2;
        case 'info':
        default:
          return 1;
      }
    };

    const minRank = rank(this.config.securityEventsMinSeverity);
    return events.filter((event) => rank(event.severity) >= minRank);
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

  public getOnlineStatus(): boolean {
    return this.reportingService.getOnlineStatus();
  }

  private mergePatchAndSoftwareRiskDetails(
    patchDetails: string | null,
    riskAssessment: SoftwareRiskAssessment
  ): string {
    const detailsParts: string[] = [];

    if (patchDetails && patchDetails.trim()) {
      detailsParts.push(patchDetails.trim());
    }

    detailsParts.push(this.softwareRiskCollector.summarize(riskAssessment));

    const merged = detailsParts.join('\n\n');
    if (merged.length <= AgentService.PATCH_DETAILS_MAX_CHARS) {
      return merged;
    }

    return `${merged.slice(0, AgentService.PATCH_DETAILS_MAX_CHARS)}\n... (truncated)`;
  }
}

