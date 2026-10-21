import { EvidenceContext, EvidencePack } from '../evidencePack';
import { failed, fromFailure, notApplicable, ok } from '../evidenceItem';
import { runAccepting, toInt } from '../probes';
import { AuditCategorySetting, AuditItems, AuditLoggingValue, EvidenceItem } from '../../types/evidence';

/** Audit subcategory GUIDs (language independent) mapped to the catalog's ids. */
const AUDIT_SUBCATEGORIES: Record<string, string> = {
  '{0cce9215-69ae-11d9-bed3-505054503030}': 'logon',
  '{0cce9216-69ae-11d9-bed3-505054503030}': 'logoff',
  '{0cce9217-69ae-11d9-bed3-505054503030}': 'account_lockout',
  '{0cce921b-69ae-11d9-bed3-505054503030}': 'special_logon',
  '{0cce922b-69ae-11d9-bed3-505054503030}': 'process_creation',
  '{0cce922f-69ae-11d9-bed3-505054503030}': 'audit_policy_change',
  '{0cce9230-69ae-11d9-bed3-505054503030}': 'authentication_policy_change',
  '{0cce9235-69ae-11d9-bed3-505054503030}': 'user_account_management',
  '{0cce9236-69ae-11d9-bed3-505054503030}': 'computer_account_management',
  '{0cce9237-69ae-11d9-bed3-505054503030}': 'security_group_management',
  '{0cce923f-69ae-11d9-bed3-505054503030}': 'credential_validation',
};

/**
 * Parses `auditpol /get /category:* /r` (CSV: machine, target, subcategory,
 * GUID, inclusion, exclusion). Inclusion text is matched in English; returns
 * null when no known subcategory could be read.
 */
export function parseAuditpolCsv(csv: string): AuditCategorySetting[] | null {
  const settings: AuditCategorySetting[] = [];
  for (const line of csv.split(/\r?\n/).slice(1)) {
    const columns = line.split(',');
    const id = AUDIT_SUBCATEGORIES[(columns[3] || '').trim().toLowerCase()];
    if (!id) continue;
    const inclusion = (columns[4] || '').trim().toLowerCase();
    if (!/success|failure|no auditing/.test(inclusion)) continue;
    settings.push({ id, success: inclusion.includes('success'), failure: inclusion.includes('failure') });
  }
  return settings.length ? settings : null;
}

/** Audit & Logging Configuration: whether security events are recorded and timestamps are reliable. Configuration only, never event content. */
export class AuditPack implements EvidencePack<'audit'> {
  readonly category = 'audit' as const;

  async collect(context: EvidenceContext): Promise<AuditItems> {
    switch (context.platform) {
      case 'windows':
        return { logging: await this.windowsLogging(context), time_sync: await this.windowsTimeSync(context) };
      case 'macos':
        return {
          // The unified log is always on and has no audit policy to configure
          logging: notApplicable('macos:unified-log'),
          time_sync: await this.macTimeSync(context),
        };
      case 'linux':
        return { logging: await this.linuxLogging(context), time_sync: await this.linuxTimeSync(context) };
    }
  }

  private async windowsLogging(context: EvidenceContext): Promise<EvidenceItem<AuditLoggingValue>> {
    const source = 'cli:auditpol,sc,wevtutil';
    const service = await context.runner.run('sc', ['query', 'eventlog'], { timeoutMs: 10000 });
    if (!service.ok) return fromFailure(source, service, context.elevated);
    const running = /STATE\s*:\s*4/.test(service.stdout);

    const auditpol = await context.runner.run('auditpol', ['/get', '/category:*', '/r'], { timeoutMs: 20000 });
    if (!auditpol.ok) return fromFailure('cli:auditpol', auditpol, context.elevated);
    const categories = parseAuditpolCsv(auditpol.stdout);
    if (!categories) return failed('cli:auditpol', 'parse_error', 'no known audit subcategories in auditpol output');

    const log = await context.runner.run('wevtutil', ['gl', 'Security'], { timeoutMs: 10000 });
    const maxBytes = log.ok ? toInt(log.stdout.match(/maxSize:\s*(\d+)/i)?.[1]) : null;

    return ok(source, {
      service: 'windows_eventlog',
      service_running: running,
      security_log_max_mb: maxBytes === null ? null : Math.round(maxBytes / (1024 * 1024)),
      categories,
    });
  }

  private async windowsTimeSync(context: EvidenceContext): Promise<EvidenceItem<{ enabled: boolean; service?: string | null }>> {
    const result = await context.runner.run('sc', ['query', 'w32time'], { timeoutMs: 10000 });
    if (!result.ok) return fromFailure('cli:sc', result, context.elevated);
    return ok('cli:sc', { enabled: /STATE\s*:\s*4/.test(result.stdout), service: 'w32time' });
  }

  private async macTimeSync(context: EvidenceContext): Promise<EvidenceItem<{ enabled: boolean; service?: string | null }>> {
    const result = await context.runner.run('systemsetup', ['-getusingnetworktime'], { timeoutMs: 10000 });
    if (!result.ok) return fromFailure('cli:systemsetup', result, context.elevated);
    if (!/network time:/i.test(result.stdout)) return failed('cli:systemsetup', 'parse_error', 'unrecognised systemsetup output');
    return ok('cli:systemsetup', { enabled: /network time:\s*on/i.test(result.stdout), service: 'timed' });
  }

  private async linuxLogging(context: EvidenceContext): Promise<EvidenceItem<AuditLoggingValue>> {
    // is-active exits 3 for inactive units and 4 for unknown (not installed) ones
    const result = await runAccepting(context, 'systemctl', ['is-active', 'auditd'], [3, 4], 10000);
    if (!result.ok) return fromFailure('cli:systemctl', result, context.elevated);
    return ok('cli:systemctl', { service: 'auditd', service_running: result.stdout.trim() === 'active', security_log_max_mb: null, categories: null });
  }

  private async linuxTimeSync(context: EvidenceContext): Promise<EvidenceItem<{ enabled: boolean; service?: string | null }>> {
    const result = await context.runner.run('timedatectl', ['show', '-p', 'NTP', '--value'], { timeoutMs: 10000 });
    if (!result.ok) return fromFailure('cli:timedatectl', result, context.elevated);
    return ok('cli:timedatectl', { enabled: result.stdout.trim() === 'yes', service: null });
  }
}
