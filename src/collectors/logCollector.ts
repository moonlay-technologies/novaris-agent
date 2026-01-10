import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DeviceLogItem, DeviceLogSeverity } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

const MAX_RAW_CHARS = 4000;

function truncate(text: string, max = MAX_RAW_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated)`;
}

function severityRank(sev: DeviceLogSeverity): number {
  switch (sev) {
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
}

function mapWindowsLevel(level: string | undefined): DeviceLogSeverity {
  const v = (level || '').toLowerCase();
  if (v.includes('critical')) return 'critical';
  if (v.includes('error')) return 'error';
  if (v.includes('warning')) return 'warning';
  return 'info';
}

function mapJournaldPriority(priority: string | undefined): DeviceLogSeverity {
  const p = Number(priority);
  // 0 emerg,1 alert,2 crit,3 err,4 warning,5 notice,6 info,7 debug
  if ([0, 1, 2].includes(p)) return 'critical';
  if (p === 3) return 'error';
  if (p === 4) return 'warning';
  return 'info';
}

function redactSecrets(input: string): string {
  return input
    .replace(/Bearer\s+[A-Za-z0-9\-\._~\+\/]+=*/g, 'Bearer [REDACTED]')
    .replace(/(api[_-]?key\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]')
    .replace(/(password\s*[:=]\s*)([^\s]+)/gi, '$1[REDACTED]');
}

export class LogCollector {
  private logger = getLogger();

  async collect(params: {
    since?: Date;
    maxItems: number;
    minSeverity: DeviceLogSeverity;
    includeRaw: boolean;
  }): Promise<{ logs: DeviceLogItem[]; cursor: Date }> {
    const platform = os.platform();
    const since = params.since;

    if (platform === 'win32') {
      return this.collectWindows({
        since,
        maxItems: params.maxItems,
        minSeverity: params.minSeverity,
        includeRaw: params.includeRaw,
      });
    }

    if (platform === 'linux') {
      return this.collectLinux({
        since,
        maxItems: params.maxItems,
        minSeverity: params.minSeverity,
        includeRaw: params.includeRaw,
      });
    }

    return { logs: [], cursor: new Date() };
  }

  private async collectWindows(params: {
    since?: Date;
    maxItems: number;
    minSeverity: DeviceLogSeverity;
    includeRaw: boolean;
  }): Promise<{ logs: DeviceLogItem[]; cursor: Date }> {
    const startTime = params.since ? params.since.toISOString() : new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const max = Math.min(Math.max(params.maxItems, 1), 500);

    // Query System + Application logs, newest first. Convert to JSON for parsing.
    const ps = [
      '$ErrorActionPreference = "Stop"',
      `$start = [datetime]::Parse('${startTime}')`,
      `$logs = @('System','Application')`,
      `$events = Get-WinEvent -FilterHashtable @{ LogName=$logs; StartTime=$start } -ErrorAction SilentlyContinue | Sort-Object TimeCreated -Descending | Select-Object -First ${max} TimeCreated, LevelDisplayName, ProviderName, LogName, Id, Message`,
      '$events | ConvertTo-Json -Compress',
    ].join('; ');

    const command = `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`;

    try {
      const { stdout } = await execAsync(command, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
      const raw = (stdout || '').trim();
      if (!raw) return { logs: [], cursor: new Date() };

      const parsed = JSON.parse(raw);
      const arr = Array.isArray(parsed) ? parsed : [parsed];

      const minRank = severityRank(params.minSeverity);
      const logs: DeviceLogItem[] = arr
        .map((e: any) => {
          const sev = mapWindowsLevel(e?.LevelDisplayName);
          const collectedAt = e?.TimeCreated ? new Date(e.TimeCreated) : new Date();
          // Ensure the date is valid
          const validDate = !isNaN(collectedAt.getTime()) ? collectedAt : new Date();
          const provider = e?.ProviderName || 'unknown';
          const logName = e?.LogName || 'eventlog';
          const source = `windows:eventlog:${logName}:${provider}`.substring(0, 100);
          const message = redactSecrets(String(e?.Message || '')).trim();
          const rawPayload = params.includeRaw ? truncate(redactSecrets(JSON.stringify(e))) : null;
          return { severity: sev, source, message, raw: rawPayload, collectedAt: validDate };
        })
        .filter((l) => l.message && l.message.length > 0)
        .filter((l) => severityRank(l.severity) >= minRank);

      // cursor: newest collectedAt (or now)
      const cursor = logs.length ? new Date(Math.max(...logs.map((l) => l.collectedAt.getTime()))) : new Date();
      return { logs, cursor };
    } catch (error: any) {
      this.logger.warn('Windows log collection failed', { error: error?.message || error });
      return { logs: [], cursor: new Date() };
    }
  }

  private async collectLinux(params: {
    since?: Date;
    maxItems: number;
    minSeverity: DeviceLogSeverity;
    includeRaw: boolean;
  }): Promise<{ logs: DeviceLogItem[]; cursor: Date }> {
    const has = async (bin: string) => {
      try {
        await execAsync(`command -v ${bin}`, { timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    };

    if (await has('journalctl')) {
      return this.collectJournald(params);
    }

    // Fallback to syslog tail
    return this.collectSyslog(params);
  }

  private async collectJournald(params: {
    since?: Date;
    maxItems: number;
    minSeverity: DeviceLogSeverity;
    includeRaw: boolean;
  }): Promise<{ logs: DeviceLogItem[]; cursor: Date }> {
    const max = Math.min(Math.max(params.maxItems, 1), 500);
    const since = params.since ? params.since.toISOString() : new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const minRank = severityRank(params.minSeverity);

    // Output one JSON object per line
    const command = `journalctl --since "${since}" -o json --no-pager -n ${max}`;

    try {
      const { stdout } = await execAsync(command, { timeout: 60000, maxBuffer: 5 * 1024 * 1024 });
      const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const logs: DeviceLogItem[] = [];

      for (const line of lines) {
        try {
          const e: any = JSON.parse(line);
          const sev = mapJournaldPriority(e?.PRIORITY);
          if (severityRank(sev) < minRank) continue;

          const msg = String(e?.MESSAGE || '').trim();
          if (!msg) continue;

          const unit = e?._SYSTEMD_UNIT || e?.SYSLOG_IDENTIFIER || e?._COMM || 'journald';
          const source = `linux:journald:${unit}`.substring(0, 100);

          // __REALTIME_TIMESTAMP is microseconds since epoch (string)
          const tsMicros = Number(e?.__REALTIME_TIMESTAMP);
          const collectedAt = Number.isFinite(tsMicros) ? new Date(tsMicros / 1000) : new Date();
          // Ensure the date is valid
          const validDate = !isNaN(collectedAt.getTime()) ? collectedAt : new Date();

          logs.push({
            severity: sev,
            source,
            message: redactSecrets(msg),
            raw: params.includeRaw ? truncate(redactSecrets(line)) : null,
            collectedAt: validDate,
          });
        } catch {
          // ignore line parse errors
        }
      }

      const cursor = logs.length ? new Date(Math.max(...logs.map((l) => l.collectedAt.getTime()))) : new Date();
      return { logs, cursor };
    } catch (error: any) {
      this.logger.warn('journald log collection failed', { error: error?.message || error });
      return { logs: [], cursor: new Date() };
    }
  }

  private async collectSyslog(params: {
    since?: Date;
    maxItems: number;
    minSeverity: DeviceLogSeverity;
    includeRaw: boolean;
  }): Promise<{ logs: DeviceLogItem[]; cursor: Date }> {
    const max = Math.min(Math.max(params.maxItems, 1), 500);
    const minRank = severityRank(params.minSeverity);

    // Choose common syslog file path
    const paths = ['/var/log/syslog', '/var/log/messages'];

    // Use shell to pick existing file + tail it
    const command = `for f in ${paths.join(' ')}; do if [ -f "$f" ]; then echo "$f"; break; fi; done`;

    try {
      const { stdout: which } = await execAsync(command, { timeout: 10000 });
      const file = (which || '').trim();
      if (!file) return { logs: [], cursor: new Date() };

      const { stdout } = await execAsync(`tail -n ${max} "${file}"`, { timeout: 10000, maxBuffer: 2 * 1024 * 1024 });
      const lines = (stdout || '').split('\n').filter(Boolean);

      const logs: DeviceLogItem[] = lines
        .map((l) => {
          // Very best-effort parsing: no reliable year in classic syslog format
          const msg = redactSecrets(l).trim();
          const sev: DeviceLogSeverity = msg.toLowerCase().includes('error')
            ? 'error'
            : msg.toLowerCase().includes('warn')
              ? 'warning'
              : 'info';

          return {
            severity: sev,
            source: `linux:syslog:${file}`.substring(0, 100),
            message: msg,
            raw: params.includeRaw ? truncate(msg) : null,
            collectedAt: new Date(),
          };
        })
        .filter((l) => severityRank(l.severity) >= minRank);

      return { logs, cursor: new Date() };
    } catch (error: any) {
      this.logger.warn('syslog log collection failed', { error: error?.message || error });
      return { logs: [], cursor: new Date() };
    }
  }
}

