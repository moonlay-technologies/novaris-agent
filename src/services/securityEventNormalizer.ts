import { createHash } from 'crypto';
import { DeviceLogItem, SecurityEvent } from '../types/device';

function classifyEventType(log: DeviceLogItem): string | null {
  const text = `${log.source} ${log.message}`.toLowerCase();

  if (
    text.includes('login failed') ||
    text.includes('failed password') ||
    text.includes('authentication failed') ||
    text.includes('invalid user')
  ) {
    return 'authentication_failure';
  }

  if (
    text.includes('service installed') ||
    text.includes('new service') ||
    text.includes('service creation')
  ) {
    return 'service_installation';
  }

  if (
    text.includes('powershell') && (text.includes(' -enc ') || text.includes('encodedcommand')) ||
    text.includes('rundll32') ||
    text.includes('wget http') ||
    text.includes('curl http') ||
    text.includes('mshta')
  ) {
    return 'suspicious_process_start';
  }

  if (
    text.includes('sudo:') && text.includes('incorrect password') ||
    text.includes('privilege escalation') ||
    text.includes('token elevation')
  ) {
    return 'privilege_escalation_attempt';
  }

  return null;
}

function buildEventId(log: DeviceLogItem, eventType: string): string {
  const base = `${eventType}|${log.source}|${log.severity}|${log.collectedAt.toISOString()}|${log.message}`;
  return createHash('sha256').update(base).digest('hex');
}

export class SecurityEventNormalizer {
  normalize(logs: DeviceLogItem[]): SecurityEvent[] {
    const events: SecurityEvent[] = [];

    for (const log of logs) {
      const eventType = classifyEventType(log);
      if (!eventType) {
        continue;
      }

      events.push({
        eventId: buildEventId(log, eventType),
        eventType,
        severity: log.severity,
        source: log.source,
        message: log.message,
        collectedAt: log.collectedAt,
        payload: log.raw ? { raw: log.raw } : null,
      });
    }

    return events;
  }
}
