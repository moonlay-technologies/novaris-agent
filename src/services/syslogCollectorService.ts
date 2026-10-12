import * as dgram from 'dgram';
import { SecurityEvent } from '../types/device';
import { classifyAsSecurityEvent } from '../utils/securityEventClassifier';
import { getLogger } from '../utils/logger';

interface BufferedSyslogMessage {
  message: string;
  senderIp: string;
  receivedAt: Date;
}

/** Strips a leading "<PRI>" (RFC3164) or "<PRI>VERSION " (RFC5424) prefix, if present. */
function stripSyslogPriAndVersion(raw: string): string {
  const match = raw.match(/^<\d{1,3}>(\d\s+)?/);
  return match ? raw.slice(match[0].length) : raw;
}

/**
 * A UDP syslog listener (default port 514). Buffers incoming messages while the
 * socket runs continuously, then on its own interval runs each buffered message
 * through the same Sigma rule set local OS logs use (`classifyAsSecurityEvent`) -
 * the existing 8 rules apply to network-sourced syslog for free (e.g. a firewall
 * logging "firewall disabled" over syslog is classified exactly like a local log).
 * Never throws on malformed input - an unparseable line is just classified against
 * its raw text as-is, matching every other collector's "never crash on bad input" convention.
 */
export class SyslogCollectorService {
  private logger = getLogger();
  private socket: dgram.Socket | null = null;
  private flushInterval: NodeJS.Timeout | null = null;
  private buffer: BufferedSyslogMessage[] = [];

  constructor(private onEvents: (events: SecurityEvent[]) => void | Promise<void>) {}

  start(port: number, flushIntervalSeconds: number): void {
    if (this.socket) {
      this.logger.warn('Syslog collector already running');
      return;
    }

    this.socket = dgram.createSocket('udp4');

    this.socket.on('message', (msg, rinfo) => {
      this.buffer.push({
        message: stripSyslogPriAndVersion(msg.toString('utf-8')).trim(),
        senderIp: rinfo.address,
        receivedAt: new Date(),
      });
    });

    this.socket.on('error', (error) => {
      this.logger.warn('Syslog UDP socket error', { error: error.message });
    });

    this.socket.bind(port, () => {
      this.logger.info(`Syslog collector listening on UDP port ${port}`);
    });

    this.flushInterval = setInterval(() => {
      this.flush().catch((error) => this.logger.error('Syslog flush failed', { error }));
    }, flushIntervalSeconds * 1000);
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.buffer = [];
  }

  private async flush(): Promise<void> {
    if (this.buffer.length === 0) {
      return;
    }

    const pending = this.buffer;
    this.buffer = [];

    const events: SecurityEvent[] = [];
    for (const item of pending) {
      const event = classifyAsSecurityEvent({
        message: item.message,
        source: `syslog:${item.senderIp}`,
        collectedAt: item.receivedAt,
      });
      if (event) {
        events.push(event);
      }
    }

    if (events.length > 0) {
      await this.onEvents(events);
    }
  }
}
