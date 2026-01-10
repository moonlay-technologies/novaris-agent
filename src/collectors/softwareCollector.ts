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
      const platform = osInfo.platform.toLowerCase();

      // Use platform-specific methods to collect installed software
      if (platform === 'win32' || platform === 'windows') {
        await this.collectWindowsSoftware(softwareList);
      } else if (platform === 'darwin' || platform === 'macos') {
        await this.collectMacSoftware(softwareList);
      } else if (platform === 'linux' || platform === 'ubuntu' || platform === 'debian' || platform === 'redhat' || platform === 'centos' || platform === 'fedora') {
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
      // Collect from both 64-bit and 32-bit registry locations
      const registryPaths = [
        'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
        'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
      ];

      for (const registryPath of registryPaths) {
        try {
          const command = `powershell -Command "Get-ItemProperty ${registryPath} | Select-Object DisplayName, DisplayVersion, InstallDate, InstallLocation | ConvertTo-Json"`;
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
            this.logger.warn(`Failed to parse Windows software list from ${registryPath}`, { error: parseError });
          }
        } catch (registryError: any) {
          this.logger.debug(`Failed to access registry path ${registryPath}`, { error: registryError.message || registryError });
        }
      }

      // Also scan for software installed on other drives (not just C:)
      await this.scanWindowsDrivesForSoftware(softwareList);
    } catch (error: any) {
      this.logger.warn('Failed to collect Windows software', { error: error.message || error });
    }
  }

  private async scanWindowsDrivesForSoftware(softwareList: InstalledSoftware[]): Promise<void> {
    try {
      // Get all available drives
      const driveCommand = `powershell -Command "Get-WmiObject -Class Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object -ExpandProperty DeviceID"`;
      const { stdout: driveStdout } = await execAsync(driveCommand);

      const drives = driveStdout.split('\n')
        .map(drive => drive.trim())
        .filter(drive => drive && drive !== 'C:'); // Skip C: drive as it's already covered by registry

      this.logger.debug(`Scanning additional drives for software: ${drives.join(', ')}`);

      // Common installation directories to scan
      const scanDirs = [
        'Program Files',
        'Program Files (x86)',
        'Users\\Public\\Desktop', // For portable apps
        'PortableApps', // Common portable apps directory
      ];

      for (const drive of drives) {
        for (const scanDir of scanDirs) {
          const fullPath = `${drive}\\${scanDir}`;
          try {
            // Check if directory exists
            const checkDirCommand = `powershell -Command "Test-Path '${fullPath}'"`;
            const { stdout: existsStdout } = await execAsync(checkDirCommand);

            if (existsStdout.trim().toLowerCase() === 'true') {
              // Scan for executables in this directory
              await this.scanDirectoryForExecutables(fullPath, softwareList);
            }
          } catch (dirError) {
            // Directory doesn't exist or can't be accessed, skip
            this.logger.debug(`Directory not accessible: ${fullPath}`);
          }
        }
      }
    } catch (error: any) {
      this.logger.warn('Failed to scan additional drives for software', { error: error.message || error });
    }
  }

  private async scanDirectoryForExecutables(directoryPath: string, softwareList: InstalledSoftware[]): Promise<void> {
    try {
      // Use PowerShell to find executables and get their version info
      const scanCommand = `
        Get-ChildItem -Path "${directoryPath}" -File -Filter "*.exe" -Depth 1 |
        Where-Object {
          $_.Name -notmatch "unins|uninstall|setup|installer|update|patch|temp|tmp" -and
          $_.Length -gt 50KB -and
          $_.Length -lt 500MB
        } |
        ForEach-Object {
          try {
            $versionInfo = (Get-ItemProperty $_.FullName).VersionInfo
            $name = $versionInfo.ProductName
            if (!$name) { $name = [System.IO.Path]::GetFileNameWithoutExtension($_.Name) }

            # Skip system and Microsoft software
            if ($name -and $name -notmatch "^(Microsoft|Windows|System|KB\\d+|Update|Hotfix|Security)") {
              [PSCustomObject]@{
                Name = $name
                Version = $versionInfo.ProductVersion
                FileVersion = $versionInfo.FileVersion
                Path = $_.FullName
                LastWriteTime = $_.LastWriteTime
              }
            }
          } catch { }
        } | ConvertTo-Json
      `;

      const { stdout } = await execAsync(scanCommand, { maxBuffer: 5 * 1024 * 1024, timeout: 15000 });

      if (stdout.trim()) {
        try {
          const executables = JSON.parse(stdout);
          const exeArray = Array.isArray(executables) ? executables : [executables];

          // Use a Set to avoid duplicates (case-insensitive)
          const existingNames = new Set(softwareList.map(s => s.name.toLowerCase()));

          for (const exe of exeArray) {
            if (exe.Name && !existingNames.has(exe.Name.toLowerCase())) {
              let installDate: Date | null = null;
              if (exe.LastWriteTime) {
                try {
                  installDate = new Date(exe.LastWriteTime);
                } catch {
                  // Ignore date parsing errors
                }
              }

              // Use ProductVersion first, fallback to FileVersion
              const version = exe.Version || exe.FileVersion || null;

              softwareList.push({
                name: exe.Name,
                version: version,
                installedAt: installDate,
              });

              existingNames.add(exe.Name.toLowerCase());
              this.logger.debug(`Found software on other drive: ${exe.Name} (${exe.Path})`);
            }
          }
        } catch (parseError) {
          this.logger.debug('Failed to parse executable scan results', { error: parseError });
        }
      }
    } catch (error: any) {
      this.logger.debug('Failed to scan directory for executables', {
        directory: directoryPath,
        error: error.message || error
      });
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
