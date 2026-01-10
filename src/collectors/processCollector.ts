import * as si from 'systeminformation';
import { ProcessData } from '../types/device';
import { getLogger } from '../utils/logger';

interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number; // CPU usage percentage
  memory: number; // Memory usage in bytes
  command: string;
  // ... other fields
}

export class ProcessCollector {
  private logger = getLogger();

  async collect(): Promise<ProcessData[]> {
    try {
      this.logger.debug('Collecting process data...');

      // Get system memory info for percentage calculations
      const [processes, memInfo] = await Promise.all([
        si.processes(),
        si.mem()
      ]);

      if (!processes || processes.list.length === 0) {
        this.logger.warn('No processes found');
        return [];
      }

      const totalMemoryBytes = memInfo.total || 1;
      this.logger.debug('System memory info', {
        totalMemoryBytes,
        totalMemoryGB: (totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(2)
      });

      // Get CPU core count for validation
      const cpuInfo = await si.cpu();
      const cpuCores = cpuInfo.cores || 1;
      const maxReasonableCpu = Math.min(100, cpuCores * 50); // Max 50% per core, capped at 100%

      this.logger.debug(`CPU info: ${cpuCores} cores, max reasonable CPU usage: ${maxReasonableCpu}%`);

      const collectedAt = new Date();

      // Filter out processes without valid PIDs first
      const validProcesses = processes.list.filter((proc) => {
        if (!proc.pid || proc.pid <= 0) {
          this.logger.debug(`Skipping process without valid PID: ${proc.name || 'unknown'} (pid: ${proc.pid})`);
          return false;
        }
        return true;
      });

      const processData: ProcessData[] = [];

      for (const proc of validProcesses) {
        try {
            // Debug: Log raw values from systeminformation
            this.logger.debug(`Raw process data for ${proc.pid} (${proc.name}):`, {
              rawCpu: proc.cpu,
              rawMem: proc.mem,
              rawMemMB: (proc.mem || 0) / (1024 * 1024),
              memRss: (proc as any).memRss,
              memVsz: (proc as any).memVsz,
              state: proc.state,
              allKeys: Object.keys(proc)
            });

          // CPU usage: Use systeminformation but apply better validation
          const rawCpuValue = proc.cpu || 0;

          // Apply more sophisticated validation
          let cpuUsage = Math.min(maxReasonableCpu, Math.max(0, rawCpuValue));

          // If systeminformation gives a value > 100%, it might be a calculation error
          // Cap at a reasonable maximum (50% per CPU core, max 100%)
          if (rawCpuValue > 100) {
            this.logger.warn(`Systeminformation reported CPU > 100% for process ${proc.pid} (${proc.name}): ${rawCpuValue.toFixed(2)}%, capping at ${maxReasonableCpu}%`);
            cpuUsage = Math.min(maxReasonableCpu, rawCpuValue * 0.1); // Assume it's 10x too high
          }

          // Very high CPU usage (>25%) for individual processes is unusual
          if (cpuUsage > 25) {
            this.logger.info(`High CPU usage detected for process ${proc.pid} (${proc.name}): ${cpuUsage.toFixed(2)}%`);
          }

          // RAM usage: Get the best available memory measurement
          // Prioritize memRss (Resident Set Size in bytes) over mem for more accurate physical memory usage
          let processMemoryBytes = (proc as any).memRss || proc.mem || 0;

          // If mem appears to be in KB instead of bytes (common on some systems), convert it
          if (processMemoryBytes > 0 && processMemoryBytes < 1024 * 1024) {
            // If value is less than 1MB, it might be in KB
            processMemoryBytes *= 1024;
            this.logger.debug(`Converted process memory from KB to bytes: ${processMemoryBytes} bytes`);
          }

          // Calculate RAM usage as percentage of total system memory
          let ramUsage = totalMemoryBytes > 0
            ? Math.min(100, Math.max(0, (processMemoryBytes / totalMemoryBytes) * 100))
            : 0;

          // Log warning if RAM usage calculation seems unreasonable
          // Note: RSS (Resident Set Size) represents actual physical memory used
          if (ramUsage > 50) {
            this.logger.warn(`High RAM usage calculated for process ${proc.pid} (${proc.name}): ${ramUsage.toFixed(2)}% (${(processMemoryBytes / (1024 * 1024)).toFixed(1)}MB RSS of ${(totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(1)}GB total system memory)`);
          }

          // Additional validation: if process memory > total system memory, that's impossible
          if (processMemoryBytes > totalMemoryBytes) {
            this.logger.warn(`Process ${proc.pid} (${proc.name}) memory (${(processMemoryBytes / (1024 * 1024 * 1024)).toFixed(2)}GB) exceeds total system memory (${(totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(2)}GB), capping at 100%`);
            ramUsage = 100;
          }

          // Skip processes with 0 CPU and 0 RAM usage (idle processes)
          if (cpuUsage === 0 && ramUsage === 0) {
            this.logger.debug(`Skipping process ${proc.pid} (${proc.name}) with 0 CPU and 0 RAM usage`);
            continue; // Skip this process
          }

          // If RAM usage is 0 but process memory is non-zero, there might be a calculation issue
          if (ramUsage === 0 && processMemoryBytes > 0) {
            this.logger.debug(`Process ${proc.pid} (${proc.name}) has ${processMemoryBytes} bytes memory but 0% RAM usage`);
          }

          // this.logger.info(`Process ${proc.pid} (${proc.name}): CPU=${cpuUsage.toFixed(2)}%, RAM=${ramUsage.toFixed(2)}% (${(processMemoryBytes / (1024 * 1024)).toFixed(1)}MB of ${(totalMemoryBytes / (1024 * 1024 * 1024)).toFixed(1)}GB total)`);

          processData.push({
            processName: proc.name || 'unknown',
            pid: proc.pid,
            cpuUsage,
            ramUsage,
            command: proc.command || null,
            collectedAt,
          });
        } catch (error) {
          this.logger.warn(`Failed to process process data for PID ${proc.pid}`, { error });
          // Skip this process if processing fails
        }
      }

      this.logger.debug(`Collected ${processData.length} processes`);
      return processData;
    } catch (error) {
      this.logger.error('Failed to collect process data', { error });
      // Return empty array instead of throwing to prevent agent crash
      return [];
    }
  }

}
