import * as si from 'systeminformation';
import { HealthMetrics } from '../types/device';
import { getLogger } from '../utils/logger';

export class HealthMetricsCollector {
  private logger = getLogger();

  async collect(): Promise<HealthMetrics> {
    try {
      // Collect CPU usage
      const cpuUsage = await this.collectCpuUsage();

      // Collect RAM usage
      const ramUsage = await this.collectRamUsage();

      // Collect disk usage
      const diskUsage = await this.collectDiskUsage();

      // Collect uptime
      const uptime = await this.collectUptime();

      return {
        cpuUsage,
        ramUsage,
        diskUsage,
        uptime,
        collectedAt: new Date(),
      };
    } catch (error) {
      this.logger.error('Failed to collect health metrics', { error });
      throw error;
    }
  }

  private async collectCpuUsage(): Promise<number> {
    try {
      const cpuData = await si.currentLoad();
      return cpuData.currentLoad || 0;
    } catch (error) {
      this.logger.warn('Failed to collect CPU usage', { error });
      return 0;
    }
  }

  private async collectRamUsage(): Promise<number> {
    try {
      const memData = await si.mem();
      if (memData.total === 0) {
        return 0;
      }
      const used = memData.used || 0;
      const total = memData.total || 1;
      return (used / total) * 100;
    } catch (error) {
      this.logger.warn('Failed to collect RAM usage', { error });
      return 0;
    }
  }

  private async collectDiskUsage(): Promise<number> {
    try {
      const fsSize = await si.fsSize();
      if (fsSize.length === 0) {
        return 0;
      }

      // Get primary drive (usually C: on Windows, / on Linux/Mac)
      const primaryDrive = fsSize[0];
      if (primaryDrive.size === 0) {
        return 0;
      }

      const used = primaryDrive.used || 0;
      const size = primaryDrive.size || 1;
      return (used / size) * 100;
    } catch (error) {
      this.logger.warn('Failed to collect disk usage', { error });
      return 0;
    }
  }

  private async collectUptime(): Promise<number> {
    try {
      const uptimeData = await si.time();
      return uptimeData.uptime || 0;
    } catch (error) {
      this.logger.warn('Failed to collect uptime', { error });
      // Fallback to Node.js os.uptime()
      const os = require('os');
      return os.uptime();
    }
  }
}

