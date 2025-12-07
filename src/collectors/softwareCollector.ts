import * as si from 'systeminformation';
import { InstalledSoftware } from '../types/device';
import { getLogger } from '../utils/logger';

export class SoftwareCollector {
  private logger = getLogger();

  async collect(): Promise<InstalledSoftware[]> {
    try {
      const softwareList: InstalledSoftware[] = [];

      // Collect installed software using systeminformation
      try {
        const software = await si.software();
        
        // The software() method returns an object with 'installed' array
        if (software && software.installed && Array.isArray(software.installed)) {
          for (const item of software.installed) {
            if (item.name) {
              softwareList.push({
                name: item.name,
                version: item.version || null,
                installedAt: item.installDate ? new Date(item.installDate) : null,
              });
            }
          }
        }
      } catch (error: any) {
        this.logger.warn('Failed to collect software list using software()', { 
          error: error.message || error 
        });
      }

      this.logger.debug(`Collected ${softwareList.length} software items`);
      return softwareList;
    } catch (error: any) {
      this.logger.error('Failed to collect software list', { 
        error: error.message || error 
      });
      return [];
    }
  }
}

