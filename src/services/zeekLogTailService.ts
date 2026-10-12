import * as fs from 'fs';
import * as path from 'path';
import { SecurityEvent } from '../types/device';
import { buildSecurityEventId } from '../utils/securityEventClassifier';
import { getLogger } from '../utils/logger';

const NOTICE_LOG_FILENAME = 'notice.log';

const CANDIDATE_LOG_DIRS: Record<string, string[]> = {
  linux: ['/opt/zeek/logs/current', '/usr/local/zeek/logs/current', '/var/log/zeek/current'],
  darwin: ['/opt/homebrew/var/zeek/logs/current', '/usr/local/var/zeek/logs/current'],
};

function parseZeekTsvLine(line: string, fields: string[]): Record<string, string> | null {
  if (!line || line.startsWith('#')) {
    return null;
  }
  const values = line.split('\t');
  const row: Record<string, string> = {};
  fields.forEach((field, index) => {
    row[field] = values[index] ?? '-';
  });
  return row;
}

/**
 * Tails an already-installed, already-running Zeek's `notice.log` (its own curated
 * alerts, not raw traffic) and forwards entries as `SecurityEvent`s. Zeek has no
 * portable Windows binary, so this is explicitly Linux/macOS only - on Windows, or
 * when no Zeek installation is found, it logs once and no-ops rather than failing.
 * This service does not install, launch, or manage the Zeek process itself.
 */
export class ZeekLogTailService {
  private logger = getLogger();
  private interval: NodeJS.Timeout | null = null;
  private logDir: string | null = null;
  private fields: string[] = [];
  private lastOffset = 0;
  private warnedMissing = false;

  constructor(private onEvents: (events: SecurityEvent[]) => void | Promise<void>) {}

  start(intervalSeconds: number, configuredLogDir?: string): void {
    if (this.interval) {
      this.logger.warn('Zeek log tail service already running');
      return;
    }

    if (process.platform === 'win32') {
      this.logger.debug('Zeek log tailing is not supported on Windows (no portable Zeek build exists); skipping.');
      return;
    }

    this.logDir = this.resolveLogDir(configuredLogDir);
    if (!this.logDir) {
      this.logger.debug(
        'Zeek notice.log not found in any known location; Zeek log tailing will not run. Install Zeek and/or set zeekLogDir to enable it.'
      );
      return;
    }

    this.logger.info(`Tailing Zeek notice.log in ${this.logDir}`);
    this.tick().catch((error) => this.logger.error('Zeek log tail failed', { error }));
    this.interval = setInterval(() => {
      this.tick().catch((error) => this.logger.error('Zeek log tail failed', { error }));
    }, intervalSeconds * 1000);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.logDir = null;
    this.fields = [];
    this.lastOffset = 0;
    this.warnedMissing = false;
  }

  private resolveLogDir(configuredLogDir?: string): string | null {
    const candidates = configuredLogDir ? [configuredLogDir] : CANDIDATE_LOG_DIRS[process.platform] || [];
    for (const dir of candidates) {
      try {
        if (fs.existsSync(path.join(dir, NOTICE_LOG_FILENAME))) {
          return dir;
        }
      } catch {
        // try next candidate
      }
    }
    return null;
  }

  private async tick(): Promise<void> {
    if (!this.logDir) {
      return;
    }
    const noticeLogPath = path.join(this.logDir, NOTICE_LOG_FILENAME);

    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(noticeLogPath);
    } catch (error: any) {
      if (!this.warnedMissing) {
        this.logger.warn(`Zeek notice.log no longer found at ${noticeLogPath}`, { error: error?.message || error });
        this.warnedMissing = true;
      }
      return;
    }
    this.warnedMissing = false;

    if (stat.size < this.lastOffset) {
      // Log was rotated/truncated - restart from the beginning.
      this.lastOffset = 0;
      this.fields = [];
    }

    if (stat.size === this.lastOffset) {
      return;
    }

    const stream = fs.createReadStream(noticeLogPath, {
      start: this.lastOffset,
      end: stat.size - 1,
      encoding: 'utf-8',
    });
    let buffer = '';
    for await (const chunk of stream) {
      buffer += chunk;
    }
    this.lastOffset = stat.size;

    const lines = buffer.split('\n').filter((line) => line.length > 0);
    const events: SecurityEvent[] = [];
    const now = new Date();

    for (const line of lines) {
      if (line.startsWith('#fields')) {
        this.fields = line.split('\t').slice(1);
        continue;
      }
      if (line.startsWith('#')) {
        continue;
      }
      if (this.fields.length === 0) {
        continue;
      }

      const row = parseZeekTsvLine(line, this.fields);
      if (!row) {
        continue;
      }

      const note = row['note'] || 'unknown';
      const msg = row['msg'] || line;
      const src = row['src'] || row['id.orig_h'] || 'unknown';
      const message = `Zeek notice [${note}]: ${msg} (src: ${src})`;

      events.push({
        eventId: buildSecurityEventId('zeek_notice', 'zeek:notice', 'warning', now, message),
        eventType: 'zeek_notice',
        severity: 'warning',
        source: 'zeek:notice',
        message,
        collectedAt: now,
        payload: { note, src, dst: row['dst'] || row['id.resp_h'] || null, raw: line },
      });
    }

    if (events.length > 0) {
      await this.onEvents(events);
    }
  }
}
