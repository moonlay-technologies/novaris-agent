import * as si from 'systeminformation';
import { InstalledSoftware } from '../types/device';
import { getLogger } from '../utils/logger';
import { queryOsquery } from '../utils/osquery';

export class SoftwareCollector {
  private logger = getLogger();

  async collect(): Promise<InstalledSoftware[]> {
    try {
      const softwareList: InstalledSoftware[] = [];

      const siApps = await this.collectViaSystemInformation();
      softwareList.push(...siApps);

      if (softwareList.length > 0) {
        this.logger.debug(`Collected ${softwareList.length} software items via systeminformation`);
        return softwareList;
      }

      // Get OS info to determine platform
      const osInfo = await si.osInfo();
      const platform = osInfo.platform.toLowerCase();

      // Use platform-specific osquery tables to collect installed software
      if (platform === 'win32' || platform === 'windows') {
        await this.collectWindowsSoftware(softwareList);
      } else if (platform === 'darwin' || platform === 'macos') {
        await this.collectMacSoftware(softwareList);
      } else if (platform === 'linux' || platform === 'ubuntu' || platform === 'debian' || platform === 'redhat' || platform === 'centos' || platform === 'fedora') {
        await this.collectLinuxSoftware(softwareList);
      } else {
        this.logger.warn(`Unsupported platform for software collection: ${platform}`);
      }

      const deduped = this.dedupeSoftware(softwareList);
      this.logger.debug(`Collected ${deduped.length} software items via fallback collectors`);
      return deduped;
    } catch (error: any) {
      this.logger.error('Failed to collect software list', {
        error: error.message || error
      });
      return [];
    }
  }

  private async collectViaSystemInformation(): Promise<InstalledSoftware[]> {
    try {
      const appsFetcher = (si as any).apps;
      if (typeof appsFetcher !== 'function') {
        return [];
      }

      const apps: any[] = await appsFetcher();
      if (!Array.isArray(apps) || apps.length === 0) {
        return [];
      }

      const softwareList: InstalledSoftware[] = apps
        .map((app: any) => {
          const name = (app?.name || app?.app || '').toString().trim();
          if (!name) {
            return null;
          }

          let installedAt: Date | null = null;
          const installDateCandidate = app?.installDate || app?.install_date || null;
          if (installDateCandidate) {
            const parsed = new Date(installDateCandidate);
            if (!Number.isNaN(parsed.getTime())) {
              installedAt = parsed;
            }
          }

          return {
            name,
            version: app?.version ? String(app.version) : null,
            installedAt,
          } satisfies InstalledSoftware;
        })
        .filter((item: InstalledSoftware | null): item is InstalledSoftware => item !== null);

      return this.dedupeSoftware(softwareList);
    } catch (error: any) {
      this.logger.warn('systeminformation apps collection failed, using fallback collectors', {
        error: error.message || error,
      });
      return [];
    }
  }

  private dedupeSoftware(softwareList: InstalledSoftware[]): InstalledSoftware[] {
    const deduped = new Map<string, InstalledSoftware>();

    for (const item of softwareList) {
      const key = `${item.name.trim().toLowerCase()}::${(item.version || '').trim().toLowerCase()}`;
      if (!deduped.has(key)) {
        deduped.set(key, item);
      }
    }

    return Array.from(deduped.values());
  }

  private async collectWindowsSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      const rows = await queryOsquery<{ name?: string; version?: string; install_date?: string }>(
        'SELECT name, version, install_date FROM programs'
      );

      softwareList.push(
        ...rows
          .filter((row) => row.name)
          .map((row) => ({
            name: row.name as string,
            version: row.version || null,
            installedAt: this.parseEightDigitDate(row.install_date),
          }))
      );
    } catch (error: any) {
      this.logger.warn('osquery programs collection failed', { error: error.message || error });
    }
  }

  private parseEightDigitDate(value: string | undefined | null): Date | null {
    if (!value || value.length !== 8) {
      return null;
    }
    const year = parseInt(value.substring(0, 4), 10);
    const month = parseInt(value.substring(4, 6), 10) - 1;
    const day = parseInt(value.substring(6, 8), 10);
    const parsed = new Date(year, month, day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private async collectMacSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      const rows = await queryOsquery<{ name?: string; bundle_short_version?: string; bundle_version?: string }>(
        'SELECT name, bundle_short_version, bundle_version FROM apps'
      );

      softwareList.push(
        ...rows
          .filter((row) => row.name)
          .map((row) => ({
            name: row.name as string,
            version: row.bundle_short_version || row.bundle_version || null,
            installedAt: null, // apps table doesn't expose an install date
          }))
      );
    } catch (error: any) {
      this.logger.warn('osquery apps collection failed', { error: error.message || error });
    }
  }

  private async collectLinuxSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      const debRows = await queryOsquery<{ name?: string; version?: string }>('SELECT name, version FROM deb_packages');
      if (debRows.length > 0) {
        softwareList.push(...debRows.filter((row) => row.name).map((row) => ({ name: row.name as string, version: row.version || null, installedAt: null })));
        return;
      }

      const rpmRows = await queryOsquery<{ name?: string; version?: string }>('SELECT name, version FROM rpm_packages');
      softwareList.push(...rpmRows.filter((row) => row.name).map((row) => ({ name: row.name as string, version: row.version || null, installedAt: null })));
    } catch (error: any) {
      this.logger.warn('osquery deb_packages/rpm_packages collection failed', { error: error.message || error });
    }
  }
}
