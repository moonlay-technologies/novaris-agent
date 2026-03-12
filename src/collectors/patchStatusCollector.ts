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

      if (platform === 'darwin') {
        const { pendingUpdates, missingCritical, details } = await this.collectMacPatchStatus();
        return {
          os: osLabel || 'macOS',
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
    const psScript = `
      $ErrorActionPreference = "Stop"
      $session = New-Object -ComObject Microsoft.Update.Session
      $searcher = $session.CreateUpdateSearcher()
      $result = $searcher.Search("IsInstalled=0 and IsHidden=0")
      $updates = $result.Updates
      $pending = $updates.Count
      $criticalCount = 0
      $titles = @()
      for ($i = 0; $i -lt $updates.Count; $i++) {
        $u = $updates.Item($i)
        if ($titles.Count -lt 5) { $titles += $u.Title }
        $catNames = @()
        foreach ($c in $u.Categories) { $catNames += $c.Name }
        if ($catNames -contains "Security Updates" -or $catNames -contains "Critical Updates") { $criticalCount++ }
      }
      $obj = [pscustomobject]@{ pending_updates = $pending; missing_critical = ($criticalCount -gt 0); critical_count = $criticalCount; sample_titles = $titles }
      $obj | ConvertTo-Json -Compress
    `.trim();

    const command = `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`;

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
      const errorMessage = error?.message || String(error);

      // Check for specific Windows Update service errors
      let details = 'Windows patch status collection failed (best-effort).';
      if (errorMessage.includes('0x80240032')) {
        details = 'Windows Update service error (0x80240032). This may indicate network issues or Windows Update service problems. Try running Windows Update manually.';
      } else if (errorMessage.includes('HRESULT')) {
        details = 'Windows Update COM API error. The Windows Update service may not be available or properly configured.';
      } else if (errorMessage.includes('Microsoft.Update.Session')) {
        details = 'Failed to create Windows Update session. Windows Update components may be corrupted or disabled.';
      }

      this.logger.warn('Windows patch status collection failed', {
        error: errorMessage,
        details,
        command: command.substring(0, 200) + '...' // Log truncated command for debugging
      });

      return {
        pendingUpdates: 0,
        missingCritical: false,
        details,
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
    if (await this.hasBinary('apt-get')) {
      return await this.collectDebianPatchStatus();
    }
    if (await this.hasBinary('dnf')) {
      return await this.collectRhelPatchStatus('dnf');
    }
    if (await this.hasBinary('yum')) {
      return await this.collectRhelPatchStatus('yum');
    }
    if (await this.hasBinary('zypper')) {
      return await this.collectZypperPatchStatus();
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
      const rebootRequired = await this.isRebootRequiredLinux();

      const sample = instLines.slice(0, 20).join('\n');
      const details = truncateDetails(
        [
          'package_manager=apt',
          `pending_updates=${pendingUpdates}`,
          `security_updates_detected=${securityLines.length}`,
          `reboot_required=${rebootRequired}`,
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

      const rebootRequired = await this.isRebootRequiredLinux();

      const missingCritical = securityCount > 0;
      const sample = pkgLines.slice(0, 20).join('\n');
      const details = truncateDetails(
        [
          `package_manager=${bin}`,
          `pending_updates=${pendingUpdates}`,
          `security_updates_detected=${securityCount}`,
          `reboot_required=${rebootRequired}`,
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

  private async collectZypperPatchStatus(): Promise<{
    pendingUpdates: number;
    missingCritical: boolean;
    details: string | null;
  }> {
    try {
      let stdout = '';
      try {
        const result = await execAsync('zypper --non-interactive list-updates', {
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
        });
        stdout = result.stdout || '';
      } catch (error: any) {
        stdout = error?.stdout || '';
      }

      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const pkgLines = lines.filter((line) => /^v\s*\|/.test(line) || /^\w+\s*\|/.test(line));
      const pendingUpdates = pkgLines.length;

      const securityLines = pkgLines.filter((line) => /security/i.test(line));
      const missingCritical = securityLines.length > 0;
      const rebootRequired = await this.isRebootRequiredLinux();

      const details = truncateDetails(
        [
          'package_manager=zypper',
          `pending_updates=${pendingUpdates}`,
          `security_updates_detected=${securityLines.length}`,
          `reboot_required=${rebootRequired}`,
          pkgLines.length
            ? `sample_updates:\n${pkgLines.slice(0, 20).join('\n')}`
            : 'sample_updates: (none)',
        ].join('\n')
      );

      return {
        pendingUpdates,
        missingCritical,
        details,
      };
    } catch (error: any) {
      this.logger.warn('SUSE patch status collection failed', { error: error?.message || error });
      return {
        pendingUpdates: 0,
        missingCritical: false,
        details: 'SUSE patch status collection failed (best-effort).',
      };
    }
  }

  private async collectMacPatchStatus(): Promise<{
    pendingUpdates: number;
    missingCritical: boolean;
    details: string | null;
  }> {
    try {
      let stdout = '';
      try {
        const result = await execAsync('softwareupdate -l', {
          timeout: 60000,
          maxBuffer: 2 * 1024 * 1024,
        });
        stdout = result.stdout || '';
      } catch (error: any) {
        stdout = `${error?.stdout || ''}\n${error?.stderr || ''}`;
      }

      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      const updateLines = lines.filter((line) => line.startsWith('*') || line.startsWith('-'));
      const pendingUpdates = updateLines.length;
      const securityLines = lines.filter((line) => /security|critical/i.test(line));
      const missingCritical = securityLines.length > 0;

      let rebootRequired = false;
      try {
        const rebootProbe = await execAsync("softwareupdate -l | grep -i 'restart'", {
          timeout: 30000,
          maxBuffer: 256 * 1024,
        });
        rebootRequired = Boolean((rebootProbe.stdout || '').trim());
      } catch {
        rebootRequired = lines.some((line) => /restart/i.test(line));
      }

      const details = truncateDetails(
        [
          'package_manager=softwareupdate',
          `pending_updates=${pendingUpdates}`,
          `security_updates_detected=${securityLines.length}`,
          `reboot_required=${rebootRequired}`,
          updateLines.length
            ? `sample_updates:\n${updateLines.slice(0, 20).join('\n')}`
            : 'sample_updates: (none)',
        ].join('\n')
      );

      return {
        pendingUpdates,
        missingCritical,
        details,
      };
    } catch (error: any) {
      this.logger.warn('macOS patch status collection failed', { error: error?.message || error });
      return {
        pendingUpdates: 0,
        missingCritical: false,
        details: 'macOS patch status collection failed (best-effort).',
      };
    }
  }

  private async isRebootRequiredLinux(): Promise<boolean> {
    try {
      await execAsync('test -f /var/run/reboot-required', { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  private async hasBinary(bin: string): Promise<boolean> {
    try {
      await execAsync(`command -v ${bin}`, { timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }
}

