import * as si from 'systeminformation';
import { exec } from 'child_process';
import { promisify } from 'util';
import { HealthMetrics } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

export class HealthMetricsCollector {
  private logger = getLogger();

  async collect(): Promise<HealthMetrics> {
    try {
      // Collect CPU usage and cores
      const { usage: cpuUsage, cores: cpuCores } = await this.collectCpuInfo();

      // Collect RAM usage
      const ramUsage = await this.collectRamUsage();

      // Collect disk usage
      const diskUsage = await this.collectDiskUsage();

      // Collect uptime
      const uptime = await this.collectUptime();

      return {
        cpuUsage,
        cpuCores,
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

  private async collectCpuInfo(): Promise<{ usage: number; cores: number }> {
    try {
      let cpuUsage = 0;
      let cpuCores = 1;
      let methodUsed = 'none';

      const os = require('os');
      const platform = os.platform();

      this.logger.info('Starting CPU usage collection', { platform });

      // Method 1: Try Windows-specific CPU usage via PowerShell
      if (platform === 'win32') {
        try {
          this.logger.info('Attempting Windows-specific CPU collection');
          const windowsUsage = await this.getWindowsCpuUsage();
          if (windowsUsage !== null) {
            cpuUsage = windowsUsage;
            methodUsed = 'windows';
            // this.logger.info('Windows CPU method succeeded', {
            //   usage: cpuUsage,
            //   method: methodUsed
            // });
          } else {
            this.logger.warn('Windows CPU method returned null');
          }
        } catch (error) {
          this.logger.warn('Windows CPU usage failed', { error });
        }
      }

      // Method 2: Fallback to systeminformation
      if (cpuUsage === 0) {
        try {
          // this.logger.info('Attempting systeminformation CPU collection');
          const cpuData = await si.currentLoad();
          const loadBasedUsage = cpuData.currentLoad || 0;
          const idleBasedUsage = 100 - (cpuData.currentLoadIdle || 0);

          // this.logger.info('Systeminformation raw data', {
          //   currentLoad: cpuData.currentLoad,
          //   currentLoadIdle: cpuData.currentLoadIdle,
          //   currentLoadUser: cpuData.currentLoadUser,
          //   currentLoadSystem: cpuData.currentLoadSystem,
          //   cpusLength: cpuData.cpus?.length
          // });

          cpuUsage = Math.max(loadBasedUsage, idleBasedUsage);
          cpuCores = cpuData.cpus?.length || 1;
          methodUsed = 'systeminformation';

          // this.logger.info('Systeminformation calculations', {
          //   loadBasedUsage,
          //   idleBasedUsage,
          //   chosenUsage: cpuUsage,
          //   chosenCores: cpuCores
          // });

        } catch (error) {
          this.logger.warn('Failed to get systeminformation CPU data', { error });
        }
      }

      // Method 3: Get CPU cores from multiple sources (only if we haven't set cores yet)
      if (cpuCores === 1) {
        try {
          const cpuInfo = await si.cpu();
          const siCores = cpuInfo.cores || 1;
          // this.logger.info('Systeminformation CPU cores', { cores: siCores });
          cpuCores = Math.max(cpuCores, siCores);
        } catch (error) {
          this.logger.warn('Failed to get CPU cores from systeminformation', { error });
        }

        // Method 4: Fallback to Node.js os
        try {
          const osCores = os.cpus().length;
          // this.logger.info('Node.js OS CPU cores', { cores: osCores });
          cpuCores = Math.max(cpuCores, osCores);
        } catch (error) {
          this.logger.warn('Failed to get CPU cores from OS', { error });
        }
      }

      // Log the final result
      // this.logger.info(`CPU Collection Complete: ${cpuUsage.toFixed(1)}% (${cpuCores} cores) via ${methodUsed}`);

      // Ensure reasonable bounds
      const clampedUsage = Math.min(100, Math.max(0, cpuUsage));
      if (clampedUsage !== cpuUsage) {
        this.logger.warn('CPU usage was clamped', { original: cpuUsage, clamped: clampedUsage });
      }

      return {
        usage: clampedUsage,
        cores: cpuCores
      };
    } catch (error) {
      this.logger.error('Failed to collect CPU info', { error });
      return { usage: 0, cores: 1 };
    }
  }

  private async getWindowsCpuUsage(): Promise<number | null> {
    this.logger.info('Starting Windows CPU usage collection');

    // Method 1: WMI via PowerShell
    try {
      const wmiCommand = `powershell -NoProfile -Command "Get-WmiObject Win32_Processor | Measure-Object -Property LoadPercentage -Average | Select-Object -ExpandProperty Average"`;

      // this.logger.info('Trying WMI CPU method', { command: wmiCommand });
      const { stdout } = await execAsync(wmiCommand, { timeout: 3000 });
      const rawOutput = stdout.trim();
      // this.logger.info('WMI raw output', { stdout: rawOutput });

      const usage = parseFloat(rawOutput);

      // this.logger.info('WMI parsing result', {
      //   rawOutput,
      //   parsedUsage: usage,
      //   isValid: !isNaN(usage) && usage >= 0 && usage <= 100
      // });

      if (!isNaN(usage) && usage >= 0 && usage <= 100) {
        // this.logger.info('WMI CPU usage successful', { usage });
        return usage;
      } else {
        this.logger.warn('WMI CPU usage invalid', { usage, isNaN: isNaN(usage) });
      }
    } catch (error) {
      this.logger.warn('WMI CPU method failed', { error });
    }

    // Method 2: Performance Counter
    try {
      const perfCommand = `powershell -NoProfile -Command "& {
        try {
          $counter = Get-Counter '\\Processor(_Total)\\% Processor Time' -SampleInterval 1 -MaxSamples 1 -ErrorAction Stop
          $value = $counter.CounterSamples[0].CookedValue
          [math]::Round($value, 2)
        } catch {
          exit 1
        }
      }"`;

      this.logger.info('Trying Performance Counter CPU method', { command: perfCommand });
      const { stdout } = await execAsync(perfCommand, { timeout: 5000 });
      const rawOutput = stdout.trim();
      this.logger.info('Performance Counter raw output', { stdout: rawOutput });

      const usage = parseFloat(rawOutput);

      this.logger.info('Performance Counter parsing result', {
        rawOutput,
        parsedUsage: usage,
        isValid: !isNaN(usage) && usage >= 0 && usage <= 100
      });

      if (!isNaN(usage) && usage >= 0 && usage <= 100) {
        this.logger.info('Performance Counter CPU usage successful', { usage });
        return usage;
      } else {
        this.logger.warn('Performance Counter CPU usage invalid', { usage, isNaN: isNaN(usage) });
      }
    } catch (error) {
      this.logger.warn('Performance Counter CPU method failed', { error });
    }

    // Method 3: typeperf
    try {
      const typeperfCommand = `typeperf "\\Processor(_Total)\\% Processor Time" -sc 1 -si 1`;

      this.logger.info('Trying typeperf CPU method', { command: typeperfCommand });
      const { stdout } = await execAsync(typeperfCommand, { timeout: 3000 });
      const rawOutput = stdout.trim();
      this.logger.info('typeperf raw output', { stdout: rawOutput });

      // Parse typeperf output - it has headers, then data
      const lines = rawOutput.split('\n');
      this.logger.info('typeperf line count', { lineCount: lines.length, lines });

      if (lines.length >= 2) {
        const dataLine = lines[lines.length - 1]; // Last line has the data
        this.logger.info('typeperf data line', { dataLine });

        const parts = dataLine.split(',');
        this.logger.info('typeperf parsed parts', { parts, partCount: parts.length });

        if (parts.length >= 2) {
          const usageStr = parts[1].trim();
          this.logger.info('typeperf usage string', { usageStr });

          const usage = parseFloat(usageStr);

          this.logger.info('typeperf parsing result', {
            usageStr,
            parsedUsage: usage,
            isValid: !isNaN(usage) && usage >= 0 && usage <= 100
          });

          if (!isNaN(usage) && usage >= 0 && usage <= 100) {
            this.logger.info('typeperf CPU usage successful', { usage });
            return usage;
          } else {
            this.logger.warn('typeperf CPU usage invalid', { usage, isNaN: isNaN(usage) });
          }
        }
      }
    } catch (error) {
      this.logger.warn('typeperf CPU method failed', { error });
    }

    this.logger.error('All Windows CPU methods failed');
    return null;
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

