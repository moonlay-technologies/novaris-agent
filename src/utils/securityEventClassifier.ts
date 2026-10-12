import * as path from 'path';
import { createHash } from 'crypto';
import { DeviceLogSeverity, SecurityEvent } from '../types/device';
import { SigmaLevel } from '../types/sigma';
import { evaluateSigmaRule, loadSigmaRules } from './sigma';

const RULES_DIR = path.join(__dirname, '../rules/sigma');

const LEVEL_TO_SEVERITY: Record<SigmaLevel, DeviceLogSeverity> = {
  informational: 'info',
  low: 'info',
  medium: 'warning',
  high: 'error',
  critical: 'critical',
};

export function buildSecurityEventId(eventType: string, source: string, severity: string, collectedAt: Date, message: string): string {
  const base = `${eventType}|${source}|${severity}|${collectedAt.toISOString()}|${message}`;
  return createHash('sha256').update(base).digest('hex');
}

export interface ClassifiableMessage {
  message: string;
  source: string;
  collectedAt: Date;
  raw?: string | null;
}

/**
 * Runs a message through the shared Sigma rule set (`src/rules/sigma`) and, on a
 * match, shapes it into a `SecurityEvent`. Shared by `securityEventNormalizer.ts`
 * (local OS logs) and `syslogCollectorService.ts` (network-sourced syslog) so both
 * get the same detection rules for free instead of maintaining separate logic.
 */
export function classifyAsSecurityEvent(input: ClassifiableMessage): SecurityEvent | null {
  const rules = loadSigmaRules(RULES_DIR);
  const fields = { message: input.message, source: input.source };
  const matchedRule = rules.find((rule) => evaluateSigmaRule(rule, fields));
  if (!matchedRule) {
    return null;
  }

  const eventType = matchedRule.event_type || matchedRule.id;
  const severity = LEVEL_TO_SEVERITY[matchedRule.level];

  return {
    eventId: buildSecurityEventId(eventType, input.source, severity, input.collectedAt, input.message),
    eventType,
    severity,
    source: input.source,
    message: input.message,
    collectedAt: input.collectedAt,
    payload: input.raw ? { raw: input.raw } : null,
  };
}
