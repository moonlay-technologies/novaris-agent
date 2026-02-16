import * as os from 'os';
import { exec } from 'child_process';
import { promisify } from 'util';
import { SecurityPostureReport } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

const DEFAULT_POSTURE: Omit<SecurityPostureReport, 'collectedAt'> = {
  antivirusInstalled: false,
  antivirusEnabled: false,
  antivirusUpToDate: false,
  antivirusProductName: null,
  firewallEnabled: false,
  firewallProfile: null,
  diskEncryptionEnabled: false,
  diskEncryptionMethod: null,
  diskEncryptionVolumes: null,
  patchMissingCritical: null,
  patchPendingUpdates: null,
  patchLastCheckedAt: null,
  metadata: null,
};

export class SecurityPostureCollector {
  private logger = getLogger();

  async collect(): Promise<SecurityPostureReport> {
    const collectedAt = new Date();
    const platform = os.platform();

    try {
      if (platform === 'win32') {
        return { collectedAt, ...(await this.collectWindows()) };
      }
      if (platform === 'darwin') {
        return { collectedAt, ...(await this.collectMac()) };
      }
      if (platform === 'linux') {
        return { collectedAt, ...(await this.collectLinux()) };
      }

      this.logger.debug('Security posture collection not supported on this platform', { platform });
      return { collectedAt, ...DEFAULT_POSTURE, metadata: { platform } };
    } catch (error: any) {
      this.logger.warn('Failed to collect security posture', { error: error?.message || error, platform });
      return { collectedAt, ...DEFAULT_POSTURE, metadata: { platform, error: error?.message || String(error) } };
    }
  }

  private async collectWindows(): Promise<Omit<SecurityPostureReport, 'collectedAt'>> {
    const psScript = `
      $ErrorActionPreference = "Stop"
      $mp = $null
      try { $mp = Get-MpComputerStatus } catch {}
      $fw = Get-NetFirewallProfile -PolicyStore ActiveStore | Select-Object Name, Enabled
      $bl = Get-BitLockerVolume | Select-Object MountPoint, VolumeStatus, ProtectionStatus, EncryptionMethod
      $obj = [pscustomobject]@{
        antivirus_installed = ($mp -ne $null)
        antivirus_enabled = if ($mp) { [bool]$mp.AntivirusEnabled } else { $false }
        antivirus_up_to_date = if ($mp) { ($mp.AntivirusSignatureAge -le 7) } else { $false }
        antivirus_product = if ($mp) { 'Windows Defender' } else { $null }
        firewall_profiles = $fw | ForEach-Object { [pscustomobject]@{ name=$_.Name; enabled=[bool]$_.Enabled } }
        bitlocker = $bl | ForEach-Object { [pscustomobject]@{ volume=$_.MountPoint; volume_status=$_.VolumeStatus; protection_status=$_.ProtectionStatus; method=$_.EncryptionMethod } }
      }
      $obj | ConvertTo-Json -Compress
    `.trim();
    const command = `powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`;

    try {
      const { stdout } = await execAsync(command, { timeout: 60000, maxBuffer: 2 * 1024 * 1024 });
      const raw = (stdout || '').trim();
      const parsed = raw ? JSON.parse(raw) : null;

      const firewallProfiles: Array<{ name?: string; enabled?: boolean }> = Array.isArray(parsed?.firewall_profiles)
        ? parsed.firewall_profiles
        : [];
      const enabledProfiles = firewallProfiles.filter((p) => p.enabled).map((p) => p.name).filter(Boolean);
      const firewallEnabled = enabledProfiles.length > 0;

      const bitlocker: Array<{ volume?: string; volume_status?: string; protection_status?: string; method?: string }> =
        Array.isArray(parsed?.bitlocker) ? parsed.bitlocker : [];
      const volumes = bitlocker.map((b) => ({
        volume: b.volume || 'unknown',
        encrypted:
          String(b.protection_status || '').toLowerCase() === 'on' ||
          String(b.volume_status || '').toLowerCase().includes('fully'),
      }));
      const encryptedVolumes = volumes.filter((v) => v.encrypted);
      const diskEncryptionEnabled = encryptedVolumes.length > 0;
      const diskEncryptionMethod =
        bitlocker.find((b) => b.method && (String(b.protection_status || '').toLowerCase() === 'on'))?.method ||
        null;

      return {
        antivirusInstalled: Boolean(parsed?.antivirus_installed),
        antivirusEnabled: Boolean(parsed?.antivirus_enabled),
        antivirusUpToDate: Boolean(parsed?.antivirus_up_to_date),
        antivirusProductName: parsed?.antivirus_product ?? null,
        firewallEnabled,
        firewallProfile: enabledProfiles.length ? enabledProfiles.join(', ') : null,
        diskEncryptionEnabled,
        diskEncryptionMethod,
        diskEncryptionVolumes: volumes.length ? volumes : null,
        patchMissingCritical: null,
        patchPendingUpdates: null,
        patchLastCheckedAt: null,
        metadata: { platform: 'windows' },
      };
    } catch (error: any) {
      this.logger.warn('Windows security posture collection failed', {
        error: error?.message || error,
      });
      return { ...DEFAULT_POSTURE, metadata: { platform: 'windows' } };
    }
  }

  private async collectMac(): Promise<Omit<SecurityPostureReport, 'collectedAt'>> {
    const metadata: Record<string, unknown> = { platform: 'mac' };

    const firewallEnabled = await this.collectMacFirewall();
    const diskEncryptionEnabled = await this.collectMacFileVault();

    return {
      antivirusInstalled: false,
      antivirusEnabled: false,
      antivirusUpToDate: false,
      antivirusProductName: null,
      firewallEnabled,
      firewallProfile: null,
      diskEncryptionEnabled,
      diskEncryptionMethod: diskEncryptionEnabled ? 'FileVault' : null,
      diskEncryptionVolumes: null,
      patchMissingCritical: null,
      patchPendingUpdates: null,
      patchLastCheckedAt: null,
      metadata,
    };
  }

  private async collectLinux(): Promise<Omit<SecurityPostureReport, 'collectedAt'>> {
    const metadata: Record<string, unknown> = { platform: 'linux' };
    const { installed, enabled, upToDate, productName } = await this.collectLinuxAntivirus();
    const { firewallEnabled, firewallProfile } = await this.collectLinuxFirewall();
    const { diskEncryptionEnabled, volumes } = await this.collectLinuxDiskEncryption();

    return {
      antivirusInstalled: installed,
      antivirusEnabled: enabled,
      antivirusUpToDate: upToDate,
      antivirusProductName: productName,
      firewallEnabled,
      firewallProfile,
      diskEncryptionEnabled,
      diskEncryptionMethod: diskEncryptionEnabled ? 'LUKS' : null,
      diskEncryptionVolumes: volumes,
      patchMissingCritical: null,
      patchPendingUpdates: null,
      patchLastCheckedAt: null,
      metadata,
    };
  }

  private async collectMacFirewall(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate', {
        timeout: 15000,
      });
      return (stdout || '').toLowerCase().includes('enabled');
    } catch {
      try {
        const { stdout } = await execAsync('defaults read /Library/Preferences/com.apple.alf globalstate', {
          timeout: 15000,
        });
        const value = parseInt((stdout || '').trim(), 10);
        return value > 0;
      } catch (error: any) {
        this.logger.warn('macOS firewall status collection failed', { error: error?.message || error });
        return false;
      }
    }
  }

  private async collectMacFileVault(): Promise<boolean> {
    try {
      const { stdout } = await execAsync('fdesetup status', { timeout: 15000 });
      return (stdout || '').toLowerCase().includes('filevault is on');
    } catch (error: any) {
      this.logger.warn('macOS FileVault status collection failed', { error: error?.message || error });
      return false;
    }
  }

  private async collectLinuxAntivirus(): Promise<{
    installed: boolean;
    enabled: boolean;
    upToDate: boolean;
    productName: string | null;
  }> {
    const has = async (bin: string) => {
      try {
        await execAsync(`command -v ${bin}`, { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    };

    const hasClam = await has('clamscan');
    if (!hasClam) {
      return { installed: false, enabled: false, upToDate: false, productName: null };
    }

    let enabled = false;
    try {
      const { stdout } = await execAsync('systemctl is-active clamav-daemon', { timeout: 5000 });
      enabled = (stdout || '').trim() === 'active';
    } catch {
      enabled = false;
    }

    return { installed: true, enabled, upToDate: enabled, productName: 'ClamAV' };
  }

  private async collectLinuxFirewall(): Promise<{ firewallEnabled: boolean; firewallProfile: string | null }> {
    const has = async (bin: string) => {
      try {
        await execAsync(`command -v ${bin}`, { timeout: 5000 });
        return true;
      } catch {
        return false;
      }
    };

    if (await has('ufw')) {
      try {
        const { stdout } = await execAsync('ufw status', { timeout: 5000 });
        const active = (stdout || '').toLowerCase().includes('status: active');
        return { firewallEnabled: active, firewallProfile: 'ufw' };
      } catch {
        return { firewallEnabled: false, firewallProfile: 'ufw' };
      }
    }

    if (await has('firewall-cmd')) {
      try {
        const { stdout } = await execAsync('firewall-cmd --state', { timeout: 5000 });
        const active = (stdout || '').trim() === 'running';
        return { firewallEnabled: active, firewallProfile: 'firewalld' };
      } catch {
        return { firewallEnabled: false, firewallProfile: 'firewalld' };
      }
    }

    try {
      const { stdout } = await execAsync('systemctl is-active firewalld', { timeout: 5000 });
      const active = (stdout || '').trim() === 'active';
      return { firewallEnabled: active, firewallProfile: 'firewalld' };
    } catch {
      return { firewallEnabled: false, firewallProfile: null };
    }
  }

  private async collectLinuxDiskEncryption(): Promise<{
    diskEncryptionEnabled: boolean;
    volumes: Array<{ volume: string; encrypted: boolean }> | null;
  }> {
    try {
      const { stdout } = await execAsync('lsblk -o NAME,FSTYPE -n', { timeout: 10000 });
      const lines = (stdout || '').split('\n').map((l) => l.trim()).filter(Boolean);
      const encrypted = lines.filter((l) => l.toLowerCase().includes('crypto_luks'));
      const volumes = encrypted.map((l) => {
        const [name] = l.split(/\s+/);
        return { volume: name || 'unknown', encrypted: true };
      });
      return {
        diskEncryptionEnabled: volumes.length > 0,
        volumes: volumes.length ? volumes : null,
      };
    } catch (error: any) {
      this.logger.warn('Linux disk encryption detection failed', { error: error?.message || error });
      return { diskEncryptionEnabled: false, volumes: null };
    }
  }
}
