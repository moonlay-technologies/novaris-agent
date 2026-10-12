import { DeviceLogItem, SecurityEvent } from '../types/device';
import { classifyAsSecurityEvent } from '../utils/securityEventClassifier';

export class SecurityEventNormalizer {
  normalize(logs: DeviceLogItem[]): SecurityEvent[] {
    const events: SecurityEvent[] = [];

    for (const log of logs) {
      const event = classifyAsSecurityEvent({
        message: log.message,
        source: log.source,
        collectedAt: log.collectedAt,
        raw: log.raw,
      });
      if (event) {
        events.push(event);
      }
    }

    return events;
  }
}
