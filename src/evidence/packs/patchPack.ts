import { EvidenceContext, EvidencePack } from '../evidencePack';
import { fromFailure, notApplicable, ok, unknown } from '../evidenceItem';
import { PatchScanner } from '../patchScanner';
import { PatchItems } from '../../types/evidence';

/** OS & Patch Health: pending updates from the OS update source, and reboot state. */
export class PatchPack implements EvidencePack<'patch'> {
  readonly category = 'patch' as const;

  constructor(private readonly scanner = new PatchScanner()) {}

  async collect(context: EvidenceContext): Promise<PatchItems> {
    const result = await this.scanner.scan(context);
    const uptime = context.uptimeSeconds();

    if (!result.ok) {
      const failure = fromFailure<never>(result.source, result.failure, context.elevated);
      return { updates: failure, reboot: failure };
    }

    const { scan } = result;
    const source = `cli:${scan.packageManager}`;
    return {
      updates: ok(scan.packageManager === 'wua' ? 'com:Microsoft.Update.Session' : source, {
        pending_total: scan.pendingTotal,
        pending_security: scan.pendingSecurity,
        oldest_pending_security_days: scan.oldestPendingSecurityDays,
        last_scan_at: scan.lastScanAt ? scan.lastScanAt.toISOString() : null,
        last_installed_at: scan.lastInstalledAt ? scan.lastInstalledAt.toISOString() : null,
        package_manager: scan.packageManager,
      }),
      reboot:
        scan.rebootPending === null
          ? context.platform === 'macos'
            ? // macOS installs and restarts in one step; there is no staged "reboot pending" state to read
              notApplicable('cli:softwareupdate')
            : unknown(`${source}:reboot`, 'tool_unavailable', 'no reboot-required indicator available')
          : ok(`${source}:reboot`, { reboot_pending: scan.rebootPending, uptime_seconds: uptime }),
    };
  }
}
