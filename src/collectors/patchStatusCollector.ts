import * as si from 'systeminformation';
import { PatchStatusReport } from '../types/device';
import { getLogger } from '../utils/logger';
import { getDefaultEvidenceContext } from '../evidence/defaultContext';
import { PatchScanner } from '../evidence/patchScanner';

const DETAILS_MAX_CHARS = 4000;

function truncateDetails(details: string): string {
  if (details.length <= DETAILS_MAX_CHARS) return details;
  return `${details.slice(0, DETAILS_MAX_CHARS)}\n... (truncated)`;
}

/**
 * Legacy /patch-status report. Scanning is shared with the compliance evidence
 * (PatchScanner); this class only keeps the old payload and `details` text format
 * that the current device page parses.
 */
export class PatchStatusCollector {
  private logger = getLogger();

  constructor(private readonly scanner = new PatchScanner()) {}

  async collect(): Promise<PatchStatusReport> {
    const lastCheckedAt = new Date();
    let osLabel = 'unknown';

    try {
      const osInfo = await si.osInfo();
      osLabel = `${osInfo.distro} ${osInfo.release}`.trim() || osInfo.platform;

      const context = await getDefaultEvidenceContext();
      if (!context) {
        return { os: osLabel, pendingUpdates: 0, missingCritical: false, lastCheckedAt, details: 'Patch status collection is not implemented for this platform.' };
      }

      const result = await this.scanner.scan(context);
      if (!result.ok) {
        this.logger.warn('Patch status collection failed', { source: result.source, error: result.failure.error });
        return { os: osLabel, pendingUpdates: 0, missingCritical: false, lastCheckedAt, details: `Patch status collection failed (${result.failure.reason}): ${result.failure.error}` };
      }

      const { scan } = result;
      const isWindows = scan.packageManager === 'wua';
      const lines = isWindows
        ? [
            `pending_updates=${scan.pendingTotal}`,
            `critical_updates_detected=${scan.pendingSecurity}`,
            `reboot_required=${scan.rebootPending ?? 'unknown'}`,
            scan.sampleTitles.length ? `sample_titles:\n- ${scan.sampleTitles.join('\n- ')}` : 'sample_titles: (none)',
          ]
        : [
            `package_manager=${scan.packageManager}`,
            `pending_updates=${scan.pendingTotal}`,
            `security_updates_detected=${scan.pendingSecurity}`,
            `reboot_required=${scan.rebootPending ?? 'unknown'}`,
            scan.sampleTitles.length ? `sample_updates:\n${scan.sampleTitles.join('\n')}` : 'sample_updates: (none)',
          ];

      return {
        os: osLabel,
        pendingUpdates: scan.pendingTotal,
        missingCritical: scan.pendingSecurity > 0,
        lastCheckedAt,
        details: truncateDetails(lines.join('\n')),
      };
    } catch (error: any) {
      this.logger.warn('Failed to collect patch status', { error: error?.message || error });
      return { os: osLabel, pendingUpdates: 0, missingCritical: false, lastCheckedAt, details: 'Failed to collect patch status.' };
    }
  }
}
