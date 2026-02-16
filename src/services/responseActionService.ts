import axios, { AxiosInstance } from 'axios';
import { exec } from 'child_process';
import * as os from 'os';
import { promisify } from 'util';
import { AgentConfig } from '../types/config';
import { ResponseAction, ResponseActionExecutionResult, ResponseActionType } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);
const MAX_OUTPUT_LENGTH = 2000;

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_LENGTH) {
    return value;
  }

  return `${value.slice(0, MAX_OUTPUT_LENGTH)}... (truncated)`;
}

export class ResponseActionService {
  private apiClient: AxiosInstance;
  private logger = getLogger();
  private resultQueue: ResponseActionExecutionResult[] = [];

  constructor(private config: AgentConfig) {
    this.apiClient = axios.create({
      baseURL: config.apiUrl,
      timeout: 30000,
      headers: {
        'X-API-Key': config.apiKey,
        'Content-Type': 'application/json',
      },
    });
  }

  async processPendingActions(deviceId: number): Promise<void> {
    await this.flushResultQueue(deviceId);

    const actions = await this.pollPendingActions(deviceId);
    if (!actions.length) {
      return;
    }

    for (const action of actions) {
      const result = await this.executeAction(action);
      await this.reportActionResult(deviceId, result);
    }
  }

  private async pollPendingActions(deviceId: number): Promise<ResponseAction[]> {
    const maxRetries = this.config.retryAttempts;

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        const response = await this.apiClient.get(`/devices/${deviceId}/response-actions/pending`);
        const rows = response.data?.data || [];
        if (!Array.isArray(rows)) {
          return [];
        }

        return rows.map((row: any) => this.toResponseAction(row));
      } catch (error: any) {
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        if (isNetworkError && attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await this.sleep(delay);
          continue;
        }

        this.logger.warn('Failed to poll pending response actions', {
          status: error.response?.status,
          message: error.response?.data?.error || error.message,
        });
        return [];
      }
    }

    return [];
  }

  private async reportActionResult(deviceId: number, result: ResponseActionExecutionResult): Promise<void> {
    const maxRetries = this.config.retryAttempts;
    const payload = {
      success: result.success,
      started_at: result.startedAt.toISOString(),
      completed_at: result.completedAt.toISOString(),
      message: result.message,
      details: result.details ?? null,
    };

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        await this.apiClient.post(`/devices/${deviceId}/response-actions/${result.actionId}/result`, payload);
        return;
      } catch (error: any) {
        const isNetworkError = !error.response || error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT';
        if (isNetworkError && attempt < maxRetries - 1) {
          const delay = this.config.retryDelay * Math.pow(2, attempt);
          await this.sleep(delay);
          continue;
        }

        this.logger.warn('Failed to report response action result; queuing', {
          actionId: result.actionId,
          status: error.response?.status,
          message: error.response?.data?.error || error.message,
        });
        this.resultQueue.push(result);
        return;
      }
    }

    this.resultQueue.push(result);
  }

  private async flushResultQueue(deviceId: number): Promise<void> {
    if (!this.resultQueue.length) {
      return;
    }

    const queued = [...this.resultQueue];
    this.resultQueue = [];

    for (const result of queued) {
      await this.reportActionResult(deviceId, result);
    }
  }

  private async executeAction(action: ResponseAction): Promise<ResponseActionExecutionResult> {
    const startedAt = new Date();

    if (!this.config.pollResponseActions) {
      return this.buildResult(action.id, startedAt, false, 'Response actions polling disabled by configuration.');
    }

    const actionAllowed = this.isAllowlisted(action.actionType);
    if (!actionAllowed) {
      return this.buildResult(action.id, startedAt, false, `Action type "${action.actionType}" is not allowlisted.`);
    }

    if (!this.config.remoteActionsEnabled) {
      return this.buildResult(action.id, startedAt, true, 'Remote actions disabled; request acknowledged without execution.', {
        dry_run: true,
        action_type: action.actionType,
      });
    }

    if (this.config.responseActionsDryRun) {
      return this.buildResult(action.id, startedAt, true, 'Dry-run mode enabled; action not executed.', {
        dry_run: true,
        action_type: action.actionType,
      });
    }

    try {
      const details = await this.executeAllowlistedAction(action);
      return this.buildResult(action.id, startedAt, true, 'Action executed successfully.', details);
    } catch (error: any) {
      return this.buildResult(action.id, startedAt, false, `Action execution failed: ${error.message || error}`, {
        action_type: action.actionType,
      });
    }
  }

  private isAllowlisted(actionType: ResponseActionType): boolean {
    return ['collect_diagnostics', 'kill_process', 'enable_firewall', 'isolate_network'].includes(actionType);
  }

  private async executeAllowlistedAction(action: ResponseAction): Promise<Record<string, unknown>> {
    switch (action.actionType) {
      case 'collect_diagnostics':
        return this.collectDiagnostics();
      case 'kill_process':
        return this.killProcess(action.parameters);
      case 'enable_firewall':
        return this.enableFirewall();
      case 'isolate_network':
        throw new Error('isolate_network is blocked until an explicit network isolation policy is enabled.');
      default:
        throw new Error(`Unsupported action type "${action.actionType}"`);
    }
  }

  private async killProcess(parameters?: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const pid = Number(parameters?.pid);
    const processName = typeof parameters?.process_name === 'string' ? parameters.process_name : null;

    if (!Number.isFinite(pid) && !processName) {
      throw new Error('kill_process requires either pid or process_name');
    }

    const platform = os.platform();
    let command: string;

    if (Number.isFinite(pid)) {
      command = platform === 'win32' ? `taskkill /PID ${pid} /F` : `kill -9 ${pid}`;
    } else {
      command = platform === 'win32' ? `taskkill /IM "${processName}" /F` : `pkill -f "${processName}"`;
    }

    const { stdout, stderr } = await execAsync(command, {
      timeout: this.config.responseActionTimeout * 1000,
      maxBuffer: 1024 * 1024,
    });

    return {
      command,
      stdout: truncateOutput(stdout || ''),
      stderr: truncateOutput(stderr || ''),
    };
  }

  private async enableFirewall(): Promise<Record<string, unknown>> {
    const platform = os.platform();
    let command = '';

    if (platform === 'win32') {
      command = 'netsh advfirewall set allprofiles state on';
    } else if (platform === 'linux') {
      command = 'if command -v ufw >/dev/null 2>&1; then ufw --force enable; else echo "ufw not installed"; fi';
    } else {
      throw new Error('enable_firewall is not supported on this OS');
    }

    const { stdout, stderr } = await execAsync(command, {
      timeout: this.config.responseActionTimeout * 1000,
      maxBuffer: 1024 * 1024,
    });

    return {
      command,
      stdout: truncateOutput(stdout || ''),
      stderr: truncateOutput(stderr || ''),
      platform,
    };
  }

  private collectDiagnostics(): Record<string, unknown> {
    return {
      platform: os.platform(),
      hostname: os.hostname(),
      uptime_seconds: os.uptime(),
      load_average: os.loadavg(),
      free_memory: os.freemem(),
      total_memory: os.totalmem(),
      collected_at: new Date().toISOString(),
    };
  }

  private buildResult(
    actionId: number,
    startedAt: Date,
    success: boolean,
    message: string,
    details: Record<string, unknown> | null = null
  ): ResponseActionExecutionResult {
    return {
      actionId,
      success,
      startedAt,
      completedAt: new Date(),
      message,
      details,
    };
  }

  private toResponseAction(row: any): ResponseAction {
    return {
      id: Number(row.id),
      actionType: (row.action_type || row.actionType || 'collect_diagnostics') as ResponseActionType,
      requestedAt: row.requested_at ? new Date(row.requested_at) : new Date(),
      parameters: row.parameters || null,
      idempotencyKey: row.idempotency_key || null,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
