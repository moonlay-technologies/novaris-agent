import * as os from 'os';
import * as si from 'systeminformation';
import { exec } from 'child_process';
import { promisify } from 'util';
import { PatchStatusReport } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

const DETAILS_MAX_CHARS = 4000;

function truncateDetails(details: string): string {
  if (details.length <= DETAILS_MAX_CHARS) return details;
  return `${details.slice(0, DETAILS_MAX_CHARS)}\n... (truncated)`;
}

export class PatchStatusCollector {
  private logger = getLogger();

  async collect(): Promise<PatchStatusReport> {
    const lastCheckedAt = new Date();

    try {
      const platform = os.platform();
      const osInfo = await si.osInfo();
      const osLabel = `${osInfo.distro} ${osInfo.release}`.trim();

      if (platform === 'win32') {
        const { pendingUpdates, missingCritical, details } = await this.collectWindowsPatchStatus();
        return {
          os: osLabel || 'Windows',
          pendingUpdates,
          missingCritical,
          lastCheckedAt,
          details,
        };
      }

      // Linux + mac: backlog only requires Windows/Linux. For mac we return "unknown / not supported".
      if (platform === 'linux') {
        const { pendingUpdates, missingCritical, details } = await this.collectLinuxPatchStatus();
        return {
          os: osLabel || 'Linux',
          pendingUpdates,
          missingCritical,
          lastCheckedAt,
          details,
        };
      }

      this.logger.debug('Patch status collection not supported on this platform', { platform });
      return {
        os: osLabel || platform,
        pendingUpdates: 0,
        missingCritical: false,
        lastCheckedAt,
        details: 'Patch status collection is not implemented for this platform.',
      };
    } catch (error: any) {
      this.logger.warn('Failed to collect patch status', { error: error?.message || error });
      return {
        os: 'unknown',
        pendingUpdates: 0,
        missingCritical: false,
        lastCheckedAt,
        details: 'Failed to collect patch status.',
      };
    }
  }

  private async collectWindowsPatchStatus(): Promise<{
    pendingUpdates: number;
    missingCritical: boolean;
    details: string | null;
  }> {
    // Uses Windows Update COM API (no external modules required)
    // Best-effort: detects pending software updates and flags security/critical category presence.
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '$session = New-Object -ComObject Microsoft.Update.Session',
      '$searcher = $session.CreateUpdateSearcher()',
      '$result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type=\\"Software\\"")',
      '$updates = $result.Updates',
      '$pending = $updates.Count',
      '$criticalCount = 0',
      '$titles = @()',
      'for ($i = 0; $i -lt $updates.Count; $i++) {',
      '  $u = $updates.Item($i)',
      '  if ($titles.Count -lt 5) { $titles += $u.Title }',
      '  $catNames = @()',
      '  foreach ($c in $u.Categories) { $catNames += $c.Name }',
      '  if ($catNames -contains "Security Updates" -or $catNames -contains "Critical Updates") { $criticalCount++ }',
      '}',
      '$obj = [pscustomobject]@{ pending_updates = $pending; missing_critical = ($criticalCount -gt 0); critical_count = $criticalCount; sample_titles = $titles }',
      '$obj | ConvertTo-Json -Compress',
    ].join('; ');

    const command = `powershell -NoProfile -Command "${ps.replace(/"/g, '\\"')}"`;

    try {
      const { stdout } = await execAsync(command, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      const raw = (stdout || '').trim();
      const parsed = raw ? JSON.parse(raw) : null;

      const pendingUpdates = Number(parsed?.pending_updates ?? 0);
      const missingCritical = Boolean(parsed?.missing_critical ?? false);
      const criticalCount = Number(parsed?.critical_count ?? 0);
      const titles: string[] = Array.isArray(parsed?.sample_titles) ? parsed.sample_titles : [];

      const details = truncateDetails(
        [
          `pending_updates=${pendingUpdates}`,
          `critical_updates_detected=${criticalCount}`,
          titles.length ? `sample_titles:\n- ${titles.join('\n- ')}` : 'sample_titles: (none)',
        ].join('\n')
      );

      return {
        pendingUpdates: Number.isFinite(pendingUpdates) && pendingUpdates >= 0 ? pendingUpdates : 0,
        missingCritical,
        details,
      };
    } catch (error: any) {
      this.logger.warn('Windows patch status collection failed', { error: error?.message || error });
      return {
        pendingUpdates: 0,
        missingCritical: false,
        details: 'Windows patch status collection failed (best-effort).',
      };
    }
  }

  private async collectLinuxPatchStatus(): Promise<{
    pendingUpdates: number;
    missingCritical: boolean;
    details: string | null;
  }> {
    // Best-effort implementation:
    // - pending updates: count upgradable packages (apt/dnf/yum)
    // - missing critical: attempts security-only count when possible, otherwise false + note in details
    const has = async (bin: string) => {
      try {
        await execAsync(`command -v ${bin}`, { timeout: 10000 });
        return true;
      } catch {
        return false;
      }
    };

    if (await has('apt-get')) {
      return await this.collectDebianPatchStatus();
    }
    if (await has('dnf')) {
      return await this.collectRhelPatchStatus('dnf');
    }
    if (await has('yum')) {
      return await this.collectRhelPatchStatus('yum');
    }

    return {
      pendingUpdates: 0,
      missingCritical: false,
      details: 'No supported package manager detected (apt-get/dnf/yum).',
    };
  }

  private async collectDebianPatchStatus(): Promise<{
    pendingUpdates: number;
    missingCritical: boolean;
    details: string | null;
  }> {
    try {
      // `apt-get -s upgrade` prints install lines prefixed with "Inst "
      const { stdout } = await execAsync('apt-get -s upgrade', { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      const lines = (stdout || '').split('\n');
      const instLines = lines.filter((l) => l.startsWith('Inst '));
      const pendingUpdates = instLines.length;

      // Heuristic: treat as "critical missing" if any line includes "security"
      const securityLines = instLines.filter((l) => l.toLowerCase().includes('security'));
      const missingCritical = securityLines.length > 0;

      const sample = instLines.slice(0, 20).join('\n');
      const details = truncateDetails(
        [
          `pending_updates=${pendingUpdates}`,
          `security_updates_detected=${securityLines.length}`,
          sample ? `sample_updates:\n${sample}` : 'sample_updates: (none)',
        ].join('\n')
      );

      return {
        pendingUpdates,
        missingCritical,
        details,
      };
    } catch (error: any) {
      this.logger.warn('Debian/Ubuntu patch status collection failed', { error: error?.message || error });
      return {
        pendingUpdates: 0,
        missingCritical: false,
        details: 'Debian/Ubuntu patch status collection failed (best-effort).',
      };
    }
  }

  private async collectRhelPatchStatus(bin: 'dnf' | 'yum'): Promise<{
    pendingUpdates: number;
    missingCritical: boolean;
    details: string | null;
  }> {
    try {
      // check-update returns 100 if updates available, 0 if none
      let stdout = '';
      try {
        const res = await execAsync(`${bin} -q check-update`, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        stdout = res.stdout || '';
      } catch (err: any) {
        // Accept exit code 100 (updates available)
        stdout = err?.stdout || '';
      }

      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      // Filter out non-package lines
      const pkgLines = lines.filter((l) => /^[a-zA-Z0-9_.+-]+\s+\S+/.test(l));
      const pendingUpdates = pkgLines.length;

      // Best-effort security updates count (may require updateinfo plugin; if fails, we don't treat as missing critical)
      let securityCount = 0;
      try {
        const sec = await execAsync(`${bin} -q updateinfo list security`, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
        securityCount = (sec.stdout || '').split('\n').map((l) => l.trim()).filter(Boolean).length;
      } catch {
        securityCount = 0;
      }

      const missingCritical = securityCount > 0;
      const sample = pkgLines.slice(0, 20).join('\n');
      const details = truncateDetails(
        [
          `pending_updates=${pendingUpdates}`,
          `security_updates_detected=${securityCount}`,
          sample ? `sample_updates:\n${sample}` : 'sample_updates: (none)',
        ].join('\n')
      );

      return {
        pendingUpdates,
        missingCritical,
        details,
      };
    } catch (error: any) {
      this.logger.warn('RHEL/Fedora patch status collection failed', { error: error?.message || error, bin });
      return {
        pendingUpdates: 0,
        missingCritical: false,
        details: 'RHEL/Fedora patch status collection failed (best-effort).',
      };
    }
  }
}

