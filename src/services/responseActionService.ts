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
  private hasLoggedMissingEndpoint = false;

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
        if (error.response?.status === 404) {
          if (!this.hasLoggedMissingEndpoint) {
            this.logger.info('Response actions endpoint not available; skipping polling');
            this.hasLoggedMissingEndpoint = true;
          }
          return [];
        }

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
      return this.buildResult(
        action.id,
        startedAt,
        false,
        this.humanizeExecutionError(error, action.actionType),
        {
          action_type: action.actionType,
          raw_error: this.extractCommandErrorDetails(error),
        }
      );
    }
  }

  private isAllowlisted(actionType: ResponseActionType): boolean {
    return ['collect_diagnostics', 'kill_process', 'enable_firewall', 'isolate_network', 'restart_device'].includes(actionType);
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
      case 'restart_device':
        return this.restartDevice(action.parameters);
      default:
        throw new Error(`Unsupported action type "${action.actionType}"`);
    }
  }

  private async restartDevice(parameters?: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const platform = os.platform();
    const rawDelay = Number(parameters?.delay_seconds);
    const delaySeconds = Number.isFinite(rawDelay)
      ? Math.max(0, Math.min(300, Math.floor(rawDelay)))
      : 30;

    let command = '';
    if (platform === 'win32') {
      command = `shutdown /r /t ${delaySeconds} /f`;
    } else if (platform === 'linux') {
      const minutes = Math.max(1, Math.ceil(delaySeconds / 60));
      command = `shutdown -r +${minutes}`;
    } else if (platform === 'darwin') {
      const minutes = Math.max(1, Math.ceil(delaySeconds / 60));
      command = `shutdown -r +${minutes}`;
    } else {
      throw new Error('restart_device is not supported on this OS');
    }

    const { stdout, stderr } = await execAsync(command, {
      timeout: this.config.responseActionTimeout * 1000,
      maxBuffer: 1024 * 1024,
    });

    return {
      command,
      platform,
      delay_seconds: delaySeconds,
      note: 'Restart command submitted. Device may go offline shortly.',
      stdout: truncateOutput(stdout || ''),
      stderr: truncateOutput(stderr || ''),
    };
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
    if (platform === 'win32') {
      // Try legacy netsh first, then PowerShell cmdlet as fallback.
      const candidates = [
        'netsh advfirewall set allprofiles state on',
        'powershell -NoProfile -Command "Set-NetFirewallProfile -Profile Domain,Public,Private -Enabled True"',
      ];

      let lastError: unknown = null;
      for (const command of candidates) {
        try {
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
        } catch (error) {
          lastError = error;
        }
      }

      const details = this.extractCommandErrorDetails(lastError);
      throw new Error(
        `Failed to enable firewall on Windows. ${details} This action may require running the agent with administrator privileges.`
      );
    }

    if (platform === 'linux') {
      const command = 'if command -v ufw >/dev/null 2>&1; then ufw --force enable; else echo "ufw not installed"; fi';
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

    throw new Error('enable_firewall is not supported on this OS');
  }

  private extractCommandErrorDetails(error: unknown): string {
    const err = error as { message?: string; code?: string; stderr?: string; stdout?: string } | null;
    if (!err) {
      return 'Unknown command error.';
    }

    const message = err.message || 'Command failed.';
    const stderr = err.stderr ? ` stderr=${truncateOutput(err.stderr)}` : '';
    const stdout = err.stdout ? ` stdout=${truncateOutput(err.stdout)}` : '';
    const code = err.code ? ` code=${String(err.code)}` : '';

    return `${message}${code}${stderr}${stdout}`.trim();
  }

  private humanizeExecutionError(error: unknown, actionType: ResponseActionType): string {
    const raw = this.extractCommandErrorDetails(error);

    if (/access is denied|permission denied|system error\s*5/i.test(raw)) {
      return `Action execution failed: ${actionType} requires administrator privileges. Restart Novaris Agent as Administrator and retry.`;
    }

    if (/not recognized|enoent|not found/i.test(raw)) {
      return 'Action execution failed: required system command is not available on this device.';
    }

    return `Action execution failed: ${raw}`;
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
