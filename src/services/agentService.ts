import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
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
import { YaraScanCollector } from '../collectors/yaraScanCollector';
import { SnmpCollector } from '../collectors/snmpCollector';
import { ActiveDiscoveryCollector } from '../collectors/activeDiscoveryCollector';
import { ReportingService } from './reportingService';
import { SecurityEventNormalizer } from './securityEventNormalizer';
import { ResponseActionService } from './responseActionService';
import { SyslogCollectorService } from './syslogCollectorService';
import { ZeekLogTailService } from './zeekLogTailService';
import { getLogger } from '../utils/logger';
import { saveConfig } from '../utils/config';
import { ProcessRegistryService } from './processRegistryService';
import { EvidenceCollector } from '../evidence/evidenceCollector';
import { EvidenceHealthTracker } from '../evidence/evidenceHealthTracker';
import { EvidenceContext } from '../evidence/evidencePack';
import { currentPlatform } from '../evidence/evidenceItem';
import { configHash } from '../evidence/runtimeInfo';
import { createEvidencePacks } from '../evidence/packs';
import { SoftwareSnapshot } from '../evidence/packs/softwarePack';
import { getDefaultEvidenceContext } from '../evidence/defaultContext';

const YARA_RULES_DIR = path.join(__dirname, '../rules/yara');

function readAgentVersion(): string {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf-8')).version || 'unknown';
  } catch {
    return 'unknown';
  }
}

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
  private yaraScanCollector: YaraScanCollector;
  private snmpCollector: SnmpCollector;
  private activeDiscoveryCollector: ActiveDiscoveryCollector;
  private reportingService: ReportingService;
  private securityEventNormalizer: SecurityEventNormalizer;
  private responseActionService: ResponseActionService;
  private syslogCollectorService: SyslogCollectorService;
  private zeekLogTailService: ZeekLogTailService;
  private logger = getLogger();
  private reportInterval: NodeJS.Timeout | null = null;
  private patchStatusInterval: NodeJS.Timeout | null = null;
  private securityPostureInterval: NodeJS.Timeout | null = null;
  private logsInterval: NodeJS.Timeout | null = null;
  private processInterval: NodeJS.Timeout | null = null;
  private yaraScanInterval: NodeJS.Timeout | null = null;
  private snmpInterval: NodeJS.Timeout | null = null;
  private activeDiscoveryInterval: NodeJS.Timeout | null = null;
  private evidenceInterval: NodeJS.Timeout | null = null;
  private evidenceCollector: EvidenceCollector | null = null;
  private queueInterval: NodeJS.Timeout | null = null;
  private responseActionsInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastDeviceInfo: DeviceReport['deviceInfo'] | null = null;
  private lastPatchStatusAt: Date | null = null;
  private lastPatchStatus: PatchStatusReport | null = null;
  private lastLogsCursorAt: Date | null = null;
  private lastSoftwareCollectedAt: number | null = null;
  private lastSoftwareList: DeviceReport['softwareList'] | undefined = undefined;
  private lastSoftwareRiskAssessment: SoftwareRiskAssessment | null = null;
  private readonly processRegistry: ProcessRegistryService;

  constructor(private config: AgentConfig, processRegistry?: ProcessRegistryService) {
    this.processRegistry = processRegistry || new ProcessRegistryService(config.logFile);
    this.registerProcesses();
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
    this.yaraScanCollector = new YaraScanCollector();
    this.snmpCollector = new SnmpCollector();
    this.activeDiscoveryCollector = new ActiveDiscoveryCollector();
    this.reportingService = new ReportingService(config);
    this.securityEventNormalizer = new SecurityEventNormalizer();
    this.responseActionService = new ResponseActionService(config);
    this.syslogCollectorService = new SyslogCollectorService((events) => this.handleCollectedSecurityEvents(events));
    this.zeekLogTailService = new ZeekLogTailService((events) => this.handleCollectedSecurityEvents(events));
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Agent is already running');
      return;
    }

    this.logger.info('Starting Novaris Agent...');
    this.processRegistry.start('agent.lifecycle');
    this.isRunning = true;

    try {
      // Validate asset tag is provided
      if (!this.config.assetTag) {
        throw new Error('Asset Tag is required. Please set NOVARIS_ASSET_TAG environment variable or config.json');
      }

      // Initial device registration or lookup. A deviceId resolved for another
      // asset tag (the tag was changed in settings) is stale and looked up again,
      // unless NOVARIS_DEVICE_ID pins the device explicitly.
      const deviceIsStale = !!this.config.deviceId
        && this.config.deviceAssetTag !== this.config.assetTag
        && !process.env.NOVARIS_DEVICE_ID;
      if (deviceIsStale) {
        this.logger.info(`Asset tag changed (${this.config.deviceAssetTag ?? 'unknown'} -> ${this.config.assetTag}); re-linking device ${this.config.deviceId}`);
        this.config.deviceId = undefined;
      }
      if (!this.config.deviceId) {
        await this.registerOrFindDevice();
      }

      // Start reporting (device info is collected with the first report)
      this.startReporting();
      this.startPatchStatusReporting();
      this.startSecurityPostureReporting();
      this.startLogsReporting();
      this.startProcessReporting();
      this.startEvidenceReporting();
      this.startYaraScanReporting();
      if (this.config.agentMode === 'network_gateway') {
        this.startSyslogCollector();
        this.startSnmpReporting();
        this.startActiveDiscoveryReporting();
        this.startZeekLogTailing();
      } else {
        this.logger.info('Endpoint mode: network monitoring disabled');
      }
      this.startResponseActionsPolling();
      this.startQueueProcessing();

      this.logger.info('Novaris Agent started successfully');
    } catch (error) {
      this.logger.error('Failed to start agent', { error });
      this.processRegistry.fail('agent.lifecycle', error);
      this.isRunning = false;
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.logger.info('Stopping Novaris Agent...');
    this.processRegistry.start('agent.shutdown');
    this.isRunning = false;

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

    if (this.evidenceInterval) {
      clearInterval(this.evidenceInterval);
      this.evidenceInterval = null;
    }

    if (this.yaraScanInterval) {
      clearInterval(this.yaraScanInterval);
      this.yaraScanInterval = null;
    }

    if (this.snmpInterval) {
      clearInterval(this.snmpInterval);
      this.snmpInterval = null;
    }

    if (this.activeDiscoveryInterval) {
      clearInterval(this.activeDiscoveryInterval);
      this.activeDiscoveryInterval = null;
    }

    this.syslogCollectorService.stop();
    this.zeekLogTailService.stop();
    if (this.config.agentMode === 'network_gateway') {
      if (this.config.collectSyslog) this.processRegistry.complete('syslog.collection');
      if (this.config.collectZeekLogs) this.processRegistry.complete('zeek.collection');
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
    this.processRegistry.complete('agent.shutdown');
    this.processRegistry.complete('agent.lifecycle');
  }

  getProcessRegistry(): ProcessRegistryService {
    return this.processRegistry;
  }

  private registerProcesses(): void {
    this.processRegistry.registerDefaults(this.config);
  }

  /**
   * Remembers runtime state in config.json. The agent keeps working from memory
   * if the file cannot be written, so a failure is only logged.
   */
  private persistConfig(fields: Partial<AgentConfig>): void {
    try {
      saveConfig(fields);
    } catch (error) {
      this.logger.warn('Failed to persist agent state to config.json', { fields: Object.keys(fields), error: (error as Error).message });
    }
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
          this.config.deviceAssetTag = this.config.assetTag;
          this.persistConfig({ deviceId: asset.deviceId, deviceAssetTag: this.config.assetTag });
          return;
        }
      }

      // Step 3: Register device (asset exists now, device will be linked to it)
      this.logger.info(`Registering device for asset ID: ${assetId}...`);
      const deviceInfo = await this.deviceInfoCollector.collect();
      this.lastDeviceInfo = deviceInfo;

      const deviceId = await this.reportingService.registerDevice(deviceInfo, this.config.assetTag);
      this.config.deviceId = deviceId;
      this.config.deviceAssetTag = this.config.assetTag;
      this.persistConfig({ deviceId, deviceAssetTag: this.config.assetTag });

      this.logger.info(`Device registered with ID: ${deviceId} for asset tag: ${this.config.assetTag}`);
    } catch (error) {
      this.logger.error('Device lookup/registration failed', { error });
      throw error;
    }
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

  private startYaraScanReporting(): void {
    if (!this.config.collectYaraScan) {
      this.logger.info('YARA scan collection disabled (collectYaraScan=false)');
      return;
    }

    this.logger.info(`Starting YARA scan reporting (interval: ${this.config.yaraScanInterval}s)`);

    this.reportYaraScan().catch((error) => {
      this.logger.error('Initial YARA scan report failed', { error });
    });

    this.yaraScanInterval = setInterval(() => {
      this.reportYaraScan().catch((error) => {
        this.logger.error('YARA scan report failed', { error });
      });
    }, this.config.yaraScanInterval * 1000);
  }

  private async reportYaraScan(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping YARA scan report');
      return;
    }

    this.processRegistry.start('yara-scan.reporting');
    try {
      const matches = await this.yaraScanCollector.collect({
        rulesDir: YARA_RULES_DIR,
        scanPaths: this.config.yaraScanPaths,
        maxFiles: this.config.yaraScanMaxFiles,
        maxFileSizeBytes: this.config.yaraScanMaxFileSizeBytes,
      });

      if (matches.length === 0) {
        return;
      }

      const collectedAt = new Date();
      const events: SecurityEvent[] = matches.map((match) => {
        const message = `YARA rule "${match.ruleName}" matched file: ${match.targetFile}`;
        const eventId = createHash('sha256')
          .update(`malware_detection|${match.ruleName}|${match.targetFile}|${collectedAt.toISOString()}`)
          .digest('hex');

        return {
          eventId,
          eventType: 'malware_detection',
          severity: 'critical',
          source: `yara:${match.ruleName}`,
          message,
          collectedAt,
          payload: { rule_name: match.ruleName, target_file: match.targetFile, tags: match.tags, meta: match.meta },
        };
      });

      const filtered = this.filterSecurityEventsBySeverity(events);
      if (filtered.length > 0) {
        await this.reportingService.reportSecurityEvents(this.config.deviceId, filtered);
      }
    } catch (error: any) {
      this.processRegistry.fail('yara-scan.reporting', error);
      this.logger.error('Failed to run/report YARA scan', { error: error?.message || error });
    } finally {
      this.processRegistry.complete('yara-scan.reporting');
    }
  }

  private async handleCollectedSecurityEvents(events: SecurityEvent[]): Promise<void> {
    if (!this.config.deviceId || events.length === 0) {
      return;
    }

    const filtered = this.filterSecurityEventsBySeverity(events);
    if (filtered.length > 0) {
      await this.reportingService.reportSecurityEvents(this.config.deviceId, filtered);
    }
  }

  private startSyslogCollector(): void {
    if (!this.config.collectSyslog) {
      this.logger.info('Syslog collection disabled (collectSyslog=false)');
      return;
    }

    this.logger.info(`Starting syslog collector (UDP port ${this.config.syslogPort}, flush interval ${this.config.syslogInterval}s)`);
    this.syslogCollectorService.start(this.config.syslogPort, this.config.syslogInterval);
    // Listens continuously, so it shows as running until the agent stops.
    this.processRegistry.start('syslog.collection');
  }

  private startSnmpReporting(): void {
    if (!this.config.collectSnmp) {
      this.logger.info('SNMP collection disabled (collectSnmp=false)');
      return;
    }

    if (this.config.snmpTargets.length === 0) {
      this.logger.warn('SNMP collection enabled but no snmpTargets configured; skipping');
      return;
    }

    this.logger.info(`Starting SNMP polling (interval: ${this.config.snmpInterval}s, targets: ${this.config.snmpTargets.length})`);

    this.reportSnmpStatus().catch((error) => {
      this.logger.error('Initial SNMP poll failed', { error });
    });

    this.snmpInterval = setInterval(() => {
      this.reportSnmpStatus().catch((error) => {
        this.logger.error('SNMP poll failed', { error });
      });
    }, this.config.snmpInterval * 1000);
  }

  private async reportSnmpStatus(): Promise<void> {
    this.processRegistry.start('snmp.polling');
    try {
      const { events } = await this.snmpCollector.collect(this.config.snmpTargets, this.config.snmpCommunity);
      await this.handleCollectedSecurityEvents(events);
    } catch (error: any) {
      this.processRegistry.fail('snmp.polling', error);
      this.logger.error('Failed to poll SNMP targets', { error: error?.message || error });
    } finally {
      this.processRegistry.complete('snmp.polling');
    }
  }

  private startActiveDiscoveryReporting(): void {
    if (!this.config.collectActiveDiscovery) {
      this.logger.info('Active network discovery disabled (collectActiveDiscovery=false)');
      return;
    }

    this.logger.info(`Starting active network discovery (interval: ${this.config.activeDiscoveryInterval}s)`);

    this.runActiveDiscovery().catch((error) => {
      this.logger.error('Initial active discovery scan failed', { error });
    });

    this.activeDiscoveryInterval = setInterval(() => {
      this.runActiveDiscovery().catch((error) => {
        this.logger.error('Active discovery scan failed', { error });
      });
    }, this.config.activeDiscoveryInterval * 1000);
  }

  private async runActiveDiscovery(): Promise<void> {
    this.processRegistry.start('network-discovery.scan');
    try {
      const { knownDevices, events } = await this.activeDiscoveryCollector.collect(this.config.knownNetworkDevices || []);
      this.config.knownNetworkDevices = knownDevices;
      this.persistConfig({ knownNetworkDevices: knownDevices });
      await this.handleCollectedSecurityEvents(events);
    } catch (error: any) {
      this.processRegistry.fail('network-discovery.scan', error);
      this.logger.error('Failed to run active network discovery', { error: error?.message || error });
    } finally {
      this.processRegistry.complete('network-discovery.scan');
    }
  }

  private startZeekLogTailing(): void {
    if (!this.config.collectZeekLogs) {
      this.logger.info('Zeek log tailing disabled (collectZeekLogs=false)');
      return;
    }

    this.zeekLogTailService.start(this.config.zeekLogsInterval, this.config.zeekLogDir);
    // Tails continuously, so it shows as running until the agent stops.
    this.processRegistry.start('zeek.collection');
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

  private startEvidenceReporting(): void {
    if (!this.config.collectEvidence) {
      this.logger.info('Compliance evidence collection disabled (collectEvidence=false)');
      return;
    }

    const platform = currentPlatform();
    if (!platform) {
      this.logger.warn('Compliance evidence is not supported on this platform', { platform: process.platform });
      return;
    }

    this.logger.info(`Starting compliance evidence reporting (interval: ${this.config.evidenceInterval}s)`);

    this.reportEvidence().catch((error) => {
      this.logger.error('Initial compliance evidence report failed', { error });
    });

    this.evidenceInterval = setInterval(() => {
      this.reportEvidence().catch((error) => {
        this.logger.error('Compliance evidence report failed', { error });
      });
    }, this.config.evidenceInterval * 1000);
  }

  private async reportEvidence(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping compliance evidence report');
      return;
    }

    this.processRegistry.start('evidence.reporting');
    try {
      const { collector, context } = await this.getEvidenceRuntime();
      const envelope = await collector.collect(context);
      await this.reportingService.reportEvidence(this.config.deviceId, envelope);
    } catch (error: any) {
      this.processRegistry.fail('evidence.reporting', error);
      this.logger.error('Failed to collect/report compliance evidence', { error: error?.message || error });
    } finally {
      this.processRegistry.complete('evidence.reporting');
    }
  }

  private async getEvidenceRuntime(): Promise<{ collector: EvidenceCollector; context: EvidenceContext }> {
    const context = await getDefaultEvidenceContext();
    if (!context) {
      throw new Error(`Compliance evidence is not supported on ${process.platform}`);
    }
    if (!this.evidenceCollector) {
      this.evidenceCollector = new EvidenceCollector(
        createEvidencePacks({ software: () => this.softwareSnapshot() }),
        new EvidenceHealthTracker(),
        () => configHash(this.config),
        readAgentVersion(),
      );
    }
    return { collector: this.evidenceCollector, context };
  }

  /** Latest software list collected for /software/sync and when the server last accepted it. */
  private softwareSnapshot(): SoftwareSnapshot {
    return {
      enabled: this.config.collectSoftware,
      items: this.lastSoftwareList ?? null,
      lastSyncedAt: this.reportingService.getLastSoftwareSyncAt(),
    };
  }

  private startResponseActionsPolling(): void {
    if (this.config.responseActionsMode === 'off') {
      this.logger.info('Response actions polling disabled (responseActionsMode=off)');
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
    this.processQueue().catch((error) => {
      this.logger.error('Initial queue processing failed', { error });
    });

    this.queueInterval = setInterval(() => {
      this.processQueue().catch((error) => {
        this.logger.error('Queue processing failed', { error });
      });
    }, intervalSeconds * 1000);
  }

  private async processQueue(): Promise<void> {
    this.processRegistry.start('offline-queue.processing');
    try {
      await this.reportingService.processQueue();
    } catch (error) {
      this.processRegistry.fail('offline-queue.processing', error);
      throw error;
    } finally {
      this.processRegistry.complete('offline-queue.processing');
    }
  }

  private async reportData(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping report');
      return;
    }

    this.processRegistry.start('health.reporting');
    try {
      this.logger.debug('Collecting health metrics and preparing report...');

      // Collect health metrics (these change frequently)
      const healthMetrics = await this.healthMetricsCollector.collect();

      let softwareList: DeviceReport['softwareList'] | undefined = this.lastSoftwareList;
      let connectedDevices: DeviceReport['connectedDevices'] | undefined = undefined;

      // Software changes rarely: collect it on the first report, then once per softwareInterval
      const now = Date.now();
      const shouldCollectSoftware = this.config.collectSoftware && (
        this.lastSoftwareCollectedAt === null
        || now - this.lastSoftwareCollectedAt >= this.config.softwareInterval * 1000
      );

      if (shouldCollectSoftware) {
        this.logger.info('Collecting software data');
        softwareList = await this.softwareCollector.collect();
        this.lastSoftwareCollectedAt = now;
        this.lastSoftwareList = softwareList; // Cache the collected software list
        this.lastSoftwareRiskAssessment = this.softwareRiskCollector.collect(softwareList || []);
      } else if (this.config.collectSoftware && this.lastSoftwareList !== undefined) {
        this.logger.debug(`Using cached software data (${softwareList?.length || 0} items)`);
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
      this.processRegistry.fail('health.reporting', error);
      this.logger.error('Failed to report data', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    } finally {
      this.processRegistry.complete('health.reporting');
    }
  }

  private async reportPatchStatus(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping patch status report');
      return;
    }

    this.processRegistry.start('patch.reporting');
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
      this.processRegistry.fail('patch.reporting', error);
      this.logger.error('Failed to report patch status', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    } finally {
      this.processRegistry.complete('patch.reporting');
    }
  }

  private async reportLogs(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping log report');
      return;
    }

    this.processRegistry.start('logs.reporting');
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
      this.persistConfig({ logsCursor: this.config.logsCursor });
    } catch (error: any) {
      this.processRegistry.fail('logs.reporting', error);
      console.log(error);
      this.logger.error('Failed to report logs', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message || error.toString(),
        response: error.response?.data,
        error
      });
      throw error;
    } finally {
      this.processRegistry.complete('logs.reporting');
    }
  }

  private async reportSecurityPosture(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping security posture report');
      return;
    }

    this.processRegistry.start('security-posture.reporting');
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
      this.processRegistry.fail('security-posture.reporting', error);
      this.logger.error('Failed to report security posture', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    } finally {
      this.processRegistry.complete('security-posture.reporting');
    }
  }

  private async reportProcesses(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping process report');
      return;
    }

    this.processRegistry.start('processes.reporting');
    try {
      const processes = await this.processCollector.collect();
      
      if (processes.length > 0) {
        await this.reportingService.reportProcesses(this.config.deviceId, processes);
      }
    } catch (error: any) {
      this.processRegistry.fail('processes.reporting', error);
      this.logger.error('Failed to report processes', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error
      });
      throw error;
    } finally {
      this.processRegistry.complete('processes.reporting');
    }
  }

  private async pollResponseActions(): Promise<void> {
    if (!this.config.deviceId) {
      this.logger.warn('Device not registered yet, skipping response actions polling');
      return;
    }

    this.processRegistry.start('response-actions.polling');
    try {
      await this.responseActionService.processPendingActions(this.config.deviceId);
    } catch (error: any) {
      this.processRegistry.fail('response-actions.polling', error);
      this.logger.error('Failed to process response actions', {
        status: error.response?.status,
        message: error.response?.data?.error || error.message,
        response: error.response?.data,
        error,
      });
      throw error;
    } finally {
      this.processRegistry.complete('response-actions.polling');
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

    const minRank = rank(this.config.logsMinSeverity);
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

