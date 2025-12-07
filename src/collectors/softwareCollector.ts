import * as si from 'systeminformation';
import { exec } from 'child_process';
import { promisify } from 'util';
import { InstalledSoftware } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

export class SoftwareCollector {
  private logger = getLogger();

  async collect(): Promise<InstalledSoftware[]> {
    try {
      const softwareList: InstalledSoftware[] = [];

      // Get OS info to determine platform
      const osInfo = await si.osInfo();
      const platform = osInfo.platform;

      // Use platform-specific methods to collect installed software
      if (platform === 'win32') {
        await this.collectWindowsSoftware(softwareList);
      } else if (platform === 'darwin') {
        await this.collectMacSoftware(softwareList);
      } else if (platform === 'linux') {
        await this.collectLinuxSoftware(softwareList);
      } else {
        this.logger.warn(`Unsupported platform for software collection: ${platform}`);
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

  private async collectWindowsSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      // Use PowerShell to get installed programs from registry
      const command = `powershell -Command "Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* | Select-Object DisplayName, DisplayVersion, InstallDate | ConvertTo-Json"`;
      const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
      
      try {
        const programs = JSON.parse(stdout);
        const programArray = Array.isArray(programs) ? programs : [programs];
        
        for (const program of programArray) {
          if (program.DisplayName) {
            let installDate: Date | null = null;
            if (program.InstallDate) {
              // InstallDate is usually in YYYYMMDD format
              const dateStr = program.InstallDate.toString();
              if (dateStr.length === 8) {
                const year = parseInt(dateStr.substring(0, 4), 10);
                const month = parseInt(dateStr.substring(4, 6), 10) - 1;
                const day = parseInt(dateStr.substring(6, 8), 10);
                installDate = new Date(year, month, day);
              }
            }

            softwareList.push({
              name: program.DisplayName,
              version: program.DisplayVersion || null,
              installedAt: installDate,
            });
          }
        }
      } catch (parseError) {
        this.logger.warn('Failed to parse Windows software list', { error: parseError });
      }
    } catch (error: any) {
      this.logger.warn('Failed to collect Windows software', { error: error.message || error });
    }
  }

  private async collectMacSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      // Use system_profiler to get installed applications
      const command = 'system_profiler SPApplicationsDataType -json';
      const { stdout } = await execAsync(command, { maxBuffer: 10 * 1024 * 1024 });
      
      try {
        const data = JSON.parse(stdout);
        if (data.SPApplicationsDataType) {
          for (const app of data.SPApplicationsDataType) {
            if (app._name) {
              softwareList.push({
                name: app._name,
                version: app.version || null,
                installedAt: null, // system_profiler doesn't provide install date
              });
            }
          }
        }
      } catch (parseError) {
        this.logger.warn('Failed to parse macOS software list', { error: parseError });
      }
    } catch (error: any) {
      this.logger.warn('Failed to collect macOS software', { error: error.message || error });
    }
  }

  private async collectLinuxSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      // Try dpkg first (Debian/Ubuntu)
      try {
        const { stdout } = await execAsync('dpkg-query -W -f=\'${Package}\t${Version}\t${Install-Date}\n\'', {
          maxBuffer: 10 * 1024 * 1024,
        });
        
        const lines = stdout.split('\n');
        for (const line of lines) {
          if (line.trim()) {
            const parts = line.split('\t');
            if (parts.length >= 2) {
              let installDate: Date | null = null;
              if (parts[2]) {
                try {
                  installDate = new Date(parseInt(parts[2], 10) * 1000); // Install-Date is in seconds
                } catch {
                  // Ignore date parsing errors
                }
              }

              softwareList.push({
                name: parts[0],
                version: parts[1] || null,
                installedAt: installDate,
              });
            }
          }
        }
      } catch (dpkgError) {
        // If dpkg fails, try rpm (RedHat/CentOS)
        try {
          const { stdout } = await execAsync('rpm -qa --queryformat \'%{NAME}\t%{VERSION}\t%{INSTALLTIME}\n\'', {
            maxBuffer: 10 * 1024 * 1024,
          });
          
          const lines = stdout.split('\n');
          for (const line of lines) {
            if (line.trim()) {
              const parts = line.split('\t');
              if (parts.length >= 2) {
                let installDate: Date | null = null;
                if (parts[2]) {
                  try {
                    installDate = new Date(parseInt(parts[2], 10) * 1000); // INSTALLTIME is in seconds
                  } catch {
                    // Ignore date parsing errors
                  }
                }

                softwareList.push({
                  name: parts[0],
                  version: parts[1] || null,
                  installedAt: installDate,
                });
              }
            }
          }
        } catch (rpmError) {
          this.logger.warn('Failed to collect Linux software using both dpkg and rpm', {
            dpkgError: dpkgError,
            rpmError: rpmError,
          });
        }
      }
    } catch (error: any) {
      this.logger.warn('Failed to collect Linux software', { error: error.message || error });
    }
  }
}
