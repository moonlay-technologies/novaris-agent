import * as os from 'os';
import * as si from 'systeminformation';
import * as fs from 'fs';
import * as path from 'path';
import { DeviceInfo } from '../types/device';
import { getLogger } from '../utils/logger';

export class DeviceInfoCollector {
  private logger = getLogger();

  async collect(): Promise<DeviceInfo> {
    try {
      const hostname = os.hostname();
      const platform = os.platform();
      
      // Determine OS type
      let osType: 'windows' | 'mac' | 'linux';
      if (platform === 'win32') {
        osType = 'windows';
      } else if (platform === 'darwin') {
        osType = 'mac';
      } else {
        osType = 'linux';
      }

      // Get OS version
      const osInfo = await si.osInfo();
      const osVersion = `${osInfo.distro} ${osInfo.release}`;

      // Get serial number
      let serialNumber: string | null = null;
      try {
        if (osType === 'windows') {
          const systemInfo = await si.system();
          serialNumber = systemInfo.serial || null;
        } else if (osType === 'mac') {
          const systemInfo = await si.system();
          serialNumber = systemInfo.serial || null;
        } else {
          // Linux - try to get from DMI
          const systemInfo = await si.system();
          serialNumber = systemInfo.serial || null;
        }
      } catch (error) {
        this.logger.warn('Failed to collect serial number', { error });
      }

      // Get current user
      const currentUser = os.userInfo().username || null;

      // Get IP address
      let ipAddress: string | null = null;
      try {
        const networkInterfaces = os.networkInterfaces();
        for (const interfaceName in networkInterfaces) {
          const interfaces = networkInterfaces[interfaceName];
          if (interfaces) {
            for (const iface of interfaces) {
              if (iface.family === 'IPv4' && !iface.internal) {
                ipAddress = iface.address;
                break;
              }
            }
            if (ipAddress) break;
          }
        }
      } catch (error) {
        this.logger.warn('Failed to collect IP address', { error });
      }

      // Get MAC address
      let macAddress: string | null = null;
      try {
        const networkInterfaces = os.networkInterfaces();
        for (const interfaceName in networkInterfaces) {
          const interfaces = networkInterfaces[interfaceName];
          if (interfaces) {
            for (const iface of interfaces) {
              if (iface.family === 'IPv4' && !iface.internal && iface.mac) {
                macAddress = iface.mac;
                break;
              }
            }
            if (macAddress) break;
          }
        }
      } catch (error) {
        this.logger.warn('Failed to collect MAC address', { error });
      }

      // Get agent version from package.json
      let agentVersion = 'unknown';
      try {
        const packageJsonPath = path.join(__dirname, '../../package.json');
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        agentVersion = packageJson.version || 'unknown';
      } catch (error) {
        this.logger.warn('Failed to collect agent version', { error });
      }

      return {
        hostname,
        serialNumber,
        currentUser,
        osType,
        osVersion,
        ipAddress,
        macAddress,
        agentVersion,
      };
    } catch (error) {
      this.logger.error('Failed to collect device info', { error });
      throw error;
    }
  }
}

