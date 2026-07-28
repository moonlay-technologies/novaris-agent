import * as fs from 'fs';
import * as path from 'path';
import { getInstallDirectory } from '../utils/config';
import { AgentConfig } from '../types/config';

export type RegisteredProcessStatus = 'idle' | 'running' | 'disabled' | 'failed';

export interface RegisteredProcess {
  id: string;
  name: string;
  description: string;
  category: 'collection' | 'reporting' | 'lifecycle' | 'integration';
  enabled: boolean;
  intervalSeconds?: number;
  status: RegisteredProcessStatus;
  runCount: number;
  lastStartedAt?: string;
  lastCompletedAt?: string;
  lastError?: string;
}

export interface ProcessRegistrySnapshot {
  generatedAt: string;
  logFile: string;
  processes: RegisteredProcess[];
}

interface ProcessState extends RegisteredProcess {
  lastStartedTimestamp?: number;
}

/** Registry for Novaris background operations and their recent execution state. */
export class ProcessRegistryService {
  private readonly processes = new Map<string, ProcessState>();

  constructor(private readonly configuredLogFile?: string) {}

  registerDefaults(config: AgentConfig): void {
    const register = (id: string, name: string, description: string, category: RegisteredProcess['category'], enabled: boolean, intervalSeconds?: number) =>
      this.register({ id, name, description, category, enabled, intervalSeconds });

    register('agent.lifecycle', 'Novaris Agent', 'Main agent lifecycle and orchestration', 'lifecycle', true);
    register('agent.shutdown', 'Graceful shutdown', 'Stops timers and drains offline queues', 'lifecycle', true);
    register('device.collection', 'Device information collection', 'Collects stable device identity and metadata', 'collection', true, config.collectInterval);
    register('health.reporting', 'Health reporting', 'Reports CPU, memory, disk, uptime, software, and connected devices', 'reporting', true, config.reportInterval);
    register('patch.reporting', 'Patch status reporting', 'Reports missing patches and pending updates', 'reporting', config.collectPatchStatus, config.patchStatusInterval);
    register('security-posture.reporting', 'Security posture reporting', 'Reports antivirus, firewall, encryption, and posture state', 'reporting', config.collectSecurityPosture, config.securityPostureInterval);
    register('logs.reporting', 'Operating system log reporting', 'Collects and reports incremental system logs', 'reporting', config.collectLogs, config.logsInterval);
    register('processes.reporting', 'Process reporting', 'Collects and reports active process snapshots', 'reporting', config.collectProcesses, config.processInterval);
    register('response-actions.polling', 'Response action polling', 'Polls and executes pending remote response actions', 'integration', config.pollResponseActions, config.responseActionsInterval);
    register('offline-queue.processing', 'Offline queue processing', 'Retries reports queued while the backend was unavailable', 'integration', true, Math.max(30, config.reportInterval));
  }

  register(process: Omit<RegisteredProcess, 'status' | 'runCount'>): void {
    const existing = this.processes.get(process.id);
    this.processes.set(process.id, {
      ...existing,
      ...process,
      status: process.enabled ? (existing?.status === 'running' ? 'running' : 'idle') : 'disabled',
      runCount: existing?.runCount ?? 0,
    });
  }

  start(id: string): void {
    const process = this.require(id);
    if (!process.enabled) {
      process.status = 'disabled';
      return;
    }
    process.status = 'running';
    process.runCount += 1;
    process.lastStartedTimestamp = Date.now();
    process.lastStartedAt = new Date().toISOString();
    process.lastError = undefined;
  }

  complete(id: string): void {
    const process = this.require(id);
    if (process.status !== 'failed') {
      process.status = process.enabled ? 'idle' : 'disabled';
    }
    process.lastCompletedAt = new Date().toISOString();
  }

  fail(id: string, error: unknown): void {
    const process = this.require(id);
    process.status = 'failed';
    process.lastError = error instanceof Error ? error.message : String(error);
  }

  setEnabled(id: string, enabled: boolean): void {
    const process = this.require(id);
    process.enabled = enabled;
    process.status = enabled ? 'idle' : 'disabled';
  }

  snapshot(): ProcessRegistrySnapshot {
    return {
      generatedAt: new Date().toISOString(),
      logFile: this.getLogFile(),
      processes: Array.from(this.processes.values()).map(({ lastStartedTimestamp: _lastStartedTimestamp, ...process }) => ({ ...process })),
    };
  }

  readLogs(lines = 200): { success: boolean; logFile: string; lines: string[]; message?: string } {
    const safeLines = Math.min(Math.max(Math.floor(lines), 1), 1000);
    const logFile = this.getLogFile();
    try {
      if (!fs.existsSync(logFile)) {
        return { success: true, logFile, lines: [], message: 'Log file does not exist yet.' };
      }
      const content = fs.readFileSync(logFile, 'utf8');
      return { success: true, logFile, lines: content.split(/\r?\n/).filter(Boolean).slice(-safeLines) };
    } catch (error) {
      return {
        success: false,
        logFile,
        lines: [],
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private getLogFile(): string {
    return this.configuredLogFile || path.join(getInstallDirectory(), 'logs', 'novaris-agent.log');
  }

  private require(id: string): ProcessState {
    const process = this.processes.get(id);
    if (!process) throw new Error(`Unknown Novaris process: ${id}`);
    return process;
  }
}
