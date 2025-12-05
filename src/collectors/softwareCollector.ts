import * as si from 'systeminformation';
import { InstalledSoftware } from '../types/device';
import { getLogger } from '../utils/logger';

export class SoftwareCollector {
  private logger = getLogger();

  async collect(): Promise<InstalledSoftware[]> {
    try {
      const softwareList: InstalledSoftware[] = [];

      // Collect installed packages/applications
      try {
        const packages = await si.getInstalledPackages();
        
        for (const pkg of packages) {
          if (pkg.name) {
            softwareList.push({
              name: pkg.name,
              version: pkg.version || null,
              installedAt: pkg.installDate ? new Date(pkg.installDate) : null,
            });
          }
        }
      } catch (error) {
        this.logger.warn('Failed to collect software list using getInstalledPackages', { error });
        
        // Fallback: try platform-specific methods
        try {
          const apps = await si.applications();
          for (const app of apps) {
            if (app.name) {
              softwareList.push({
                name: app.name,
                version: app.version || null,
                installedAt: null,
              });
            }
          }
        } catch (fallbackError) {
          this.logger.warn('Failed to collect software list using applications', { error: fallbackError });
        }
      }

      this.logger.debug(`Collected ${softwareList.length} software items`);
      return softwareList;
    } catch (error) {
      this.logger.error('Failed to collect software list', { error });
      return [];
    }
  }
}

