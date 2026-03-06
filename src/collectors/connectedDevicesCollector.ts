import * as si from 'systeminformation';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ConnectedDevice } from '../types/device';
import { getLogger } from '../utils/logger';

const execAsync = promisify(exec);

export class ConnectedDevicesCollector {
  private logger = getLogger();

  constructor(private options: { includeNetworkNeighbors?: boolean } = {}) {}

  async collect(): Promise<ConnectedDevice[]> {
    const items: ConnectedDevice[] = [];

    try {
      await this.collectUsb(items);
      await this.collectBluetooth(items);
      await this.collectDisplays(items);
      await this.collectPrinters(items);
      await this.collectWifiAndRouter(items);

      if (this.options.includeNetworkNeighbors !== false) {
        await this.collectNetworkNeighbors(items);
      }

      const unique = new Map<string, ConnectedDevice>();
      for (const item of items) {
        unique.set(`${item.kind}:${item.identifier}`, item);
      }

      const result = Array.from(unique.values()).filter((item) => item.isConnected);
      this.logger.debug(`Collected ${result.length} connected devices`);
      return result;
    } catch (error: any) {
      this.logger.error('Failed to collect connected devices', {
        error: error.message || error,
      });
      return [];
    }
  }

  private async collectUsb(items: ConnectedDevice[]): Promise<void> {
    try {
      const usbList: any[] = await si.usb();
      const windowsUsbRows = await this.getWindowsUsbDevices();

      for (const usb of usbList) {
        const matchedWindowsDevice = this.matchWindowsUsbDevice(usb, windowsUsbRows);
        const parsedDeviceId = this.parsePnpDeviceId(this.nullable(usb.deviceId));
        const derivedVendorId = this.normalizeHexId(usb.vendorId) || parsedDeviceId.vid;
        const derivedProductId = this.normalizeHexId(usb.productId) || parsedDeviceId.pid;
        const derivedSerial = this.nullable(usb.serialNumber || matchedWindowsDevice?.serial || parsedDeviceId.serial);
        const vendor =
          this.nullable(usb.manufacturer || usb.vendor || matchedWindowsDevice?.manufacturer) ||
          this.mapUsbVendorByVid(derivedVendorId);
        const model = this.nullable(
          matchedWindowsDevice?.name ||
            usb.name ||
            (usb.type && usb.type.toLowerCase() !== 'unknown' ? usb.type : null)
        );
        const displayName = this.limit(
          usb.name ||
            matchedWindowsDevice?.name ||
            usb.type ||
            'USB Device',
          255
        );

        if (this.isUsbInfrastructureDevice(displayName, model, usb.deviceId, matchedWindowsDevice?.pnpDeviceId)) {
          continue;
        }

        const identifier = this.limit(
          usb.id ||
          [derivedVendorId, derivedProductId, usb.deviceId, usb.busNumber]
            .filter(Boolean)
            .join(':') ||
          usb.name ||
          'usb-unknown',
          255
        );

        items.push({
          kind: 'usb',
          identifier,
          displayName,
          vendor,
          model,
          serialNumber: derivedSerial,
          isConnected: true,
          metadata: {
            bus_number: usb.busNumber ?? null,
            device_id: usb.deviceId ?? null,
            vendor_id: derivedVendorId,
            product_id: derivedProductId,
            pnp_device_id: matchedWindowsDevice?.pnpDeviceId ?? usb.deviceId ?? null,
          },
        });
      }
    } catch (error: any) {
      this.logger.warn('Failed to collect USB devices', { error: error.message || error });
    }
  }

  private async collectBluetooth(items: ConnectedDevice[]): Promise<void> {
    try {
      const bluetoothList: any[] = await si.bluetoothDevices();
      const windowsBluetoothRows = await this.getWindowsBluetoothDevices();

      for (const device of bluetoothList) {
        const displayName = this.limit(device.name || 'Bluetooth Device', 255);
        if (!this.isLikelyUserBluetoothDevice(displayName)) {
          continue;
        }

        const matchedWindowsDevice = this.matchWindowsBluetoothDevice(device, windowsBluetoothRows);
        const vendorFromName = this.extractVendorFromText(device.name, matchedWindowsDevice?.name);
        const baseVendor = this.nullable(device.manufacturer || matchedWindowsDevice?.manufacturer);
        const vendor = this.isGenericVendor(baseVendor) ? this.nullable(vendorFromName) : baseVendor;
        const model = this.nullable(device.type || matchedWindowsDevice?.name || device.name);

        const identifier = this.limit(device.macDevice || device.address || device.name || 'bluetooth-unknown', 255);
        items.push({
          kind: 'bluetooth',
          identifier,
          displayName: this.limit(matchedWindowsDevice?.name || displayName, 255),
          vendor,
          model,
          serialNumber: this.nullable(matchedWindowsDevice?.serial),
          isConnected: device.connected !== false,
          metadata: {
            battery_percent: device.batteryPercent ?? null,
            pnp_device_id: matchedWindowsDevice?.pnpDeviceId ?? null,
          },
        });
      }
    } catch (error: any) {
      this.logger.warn('Failed to collect Bluetooth devices', { error: error.message || error });
    }
  }

  private async collectDisplays(items: ConnectedDevice[]): Promise<void> {
    try {
      const graphics: any = await si.graphics();
      const displays: any[] = graphics.displays || [];
      await this.enrichWindowsDisplays(displays);
      displays.forEach((display, index) => {
        this.enrichDisplayFromEdid(display);

        const identifier = this.limit(
          display.deviceName ||
            display.edid ||
            [display.vendor, display.model, display.connection].filter(Boolean).join(':') ||
            `display-${index + 1}`,
          255
        );

        items.push({
          kind: 'display',
          identifier,
          displayName: this.limit(display.model || display.userFriendlyName || display.deviceName || `Display ${index + 1}`, 255),
          vendor: this.nullable(display.vendor || display.manufacturer),
          model: this.nullable(display.model || display.userFriendlyName),
          serialNumber: this.nullable(display.serial || display.serialNumber),
          isConnected: true,
          metadata: {
            main: !!display.main,
            builtin: !!display.builtin,
            connection: display.connection ?? null,
            current_res_x: display.currentResX ?? null,
            current_res_y: display.currentResY ?? null,
            current_refresh_rate: display.currentRefreshRate ?? null,
            edid_manufacturer_id: display.edidManufacturerId ?? null,
            edid_product_code: display.edidProductCode ?? null,
            edid_serial_number: display.edidSerialNumber ?? null,
          },
        });
      });
    } catch (error: any) {
      this.logger.warn('Failed to collect display devices', { error: error.message || error });
    }
  }

  private async collectPrinters(items: ConnectedDevice[]): Promise<void> {
    try {
      const printers: any[] = await si.printer();
      const windowsPrinters = await this.getWindowsPrinters();

      printers.forEach((printer) => {
        const printerName = this.limit(printer.name || printer.model || 'Printer', 255);
        if (this.isVirtualPrinter(printerName, printer.model)) {
          return;
        }

        const matchedWindowsPrinter = this.matchWindowsPrinter(printer, windowsPrinters);
        const inferredVendor = this.extractVendorFromText(
          matchedWindowsPrinter?.name,
          matchedWindowsPrinter?.driverName,
          printer.model,
          printer.name
        );
        const inferredModel = this.extractModelFromText(matchedWindowsPrinter?.name, printer.model, printer.name);

        const identifier = this.limit(printer.uri || printer.name || printer.model || 'printer-unknown', 255);
        const printerStatus = (printer.status || '').toString().toLowerCase();
        const windowsStatus = this.nullable(matchedWindowsPrinter?.status)?.toLowerCase() || '';
        const isConnected = this.isPrinterConnected(printerStatus || windowsStatus);
        if (!isConnected) {
          return;
        }

        items.push({
          kind: 'printer',
          identifier: this.limit(matchedWindowsPrinter?.name || identifier, 255),
          displayName: this.limit(matchedWindowsPrinter?.name || printerName, 255),
          vendor: this.nullable(inferredVendor),
          model: this.nullable(inferredModel),
          serialNumber: this.nullable(matchedWindowsPrinter?.serial),
          isConnected,
          metadata: {
            uri: printer.uri ?? null,
            status: printer.status ?? null,
            is_default: !!printer.default,
            is_local: !!printer.local,
            is_shared: !!printer.shared,
            driver_name: matchedWindowsPrinter?.driverName ?? null,
            port_name: matchedWindowsPrinter?.portName ?? null,
            pnp_device_id: matchedWindowsPrinter?.pnpDeviceId ?? null,
          },
        });
      });
    } catch (error: any) {
      this.logger.warn('Failed to collect printers', { error: error.message || error });
    }
  }

  private async collectWifiAndRouter(items: ConnectedDevice[]): Promise<void> {
    try {
      const connections: any[] = await si.wifiConnections();
      const activeConnection = connections.find((connection) => connection && (connection.ssid || connection.bssid));
      if (!activeConnection) {
        return;
      }

      const gatewayIp = await this.getDefaultGatewayIp();
      const gatewayMac = gatewayIp ? await this.resolveMacFromArp(gatewayIp) : null;
      const gatewayVendor = gatewayMac ? this.inferVendorFromMac(gatewayMac) : null;
      const displayName = this.limit(
        activeConnection.ssid
          ? `Router (${activeConnection.ssid})`
          : gatewayIp
            ? `Router (${gatewayIp})`
            : 'Router',
        255
      );

      const identifier = this.limit(gatewayMac || activeConnection.bssid || gatewayIp || activeConnection.ssid || 'router', 255);
      items.push({
        kind: 'network_neighbor',
        identifier,
        displayName,
        vendor: gatewayVendor,
        model: null,
        serialNumber: null,
        isConnected: true,
        metadata: {
          role: 'router',
          ssid: activeConnection.ssid ?? null,
          bssid: activeConnection.bssid ?? null,
          wifi_channel: activeConnection.channel ?? null,
          wifi_frequency: activeConnection.frequency ?? null,
          wifi_security: activeConnection.security ?? null,
          wifi_signal_level: activeConnection.signalLevel ?? null,
          wifi_quality: activeConnection.quality ?? null,
          interface: activeConnection.iface ?? null,
          gateway_ip: gatewayIp,
          gateway_mac: gatewayMac,
          gateway_vendor: gatewayVendor,
        },
      });
    } catch (error: any) {
      this.logger.warn('Failed to collect wifi/router details', { error: error.message || error });
    }
  }

  private async collectNetworkNeighbors(items: ConnectedDevice[]): Promise<void> {
    try {
      const osInfo = await si.osInfo();
      const platform = (osInfo.platform || '').toLowerCase();

      if (platform.includes('win')) {
        const { stdout } = await execAsync('arp -a', { maxBuffer: 5 * 1024 * 1024 });
        this.parseWindowsArp(stdout, items);
        return;
      }

      try {
        const { stdout } = await execAsync('ip neigh', { maxBuffer: 5 * 1024 * 1024 });
        this.parseIpNeigh(stdout, items);
      } catch {
        const { stdout } = await execAsync('arp -a', { maxBuffer: 5 * 1024 * 1024 });
        this.parseUnixArp(stdout, items);
      }
    } catch (error: any) {
      this.logger.warn('Failed to collect network neighbors', { error: error.message || error });
    }
  }

  private parseWindowsArp(output: string, items: ConnectedDevice[]): void {
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^\s*([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+([0-9a-fA-F-]{17})\s+(\w+)/);
      if (!match) continue;
      const ip = match[1];
      const mac = match[2].toLowerCase().replace(/-/g, ':');
      const type = match[3].toLowerCase();
      items.push({
        kind: 'network_neighbor',
        identifier: this.limit(mac || ip, 255),
        displayName: this.limit(`${ip} (${mac})`, 255),
        vendor: null,
        model: null,
        serialNumber: null,
        isConnected: true,
        metadata: {
          ip_address: ip,
          mac_address: mac,
          entry_type: type,
          source: 'arp',
        },
      });
    }
  }

  private parseIpNeigh(output: string, items: ConnectedDevice[]): void {
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/^([0-9]{1,3}(?:\.[0-9]{1,3}){3})\s+dev\s+(\S+)\s+lladdr\s+([0-9a-fA-F:]{17})\s+(\S+)/);
      if (!match) continue;
      const ip = match[1];
      const iface = match[2];
      const mac = match[3].toLowerCase();
      const state = match[4].toLowerCase();

      items.push({
        kind: 'network_neighbor',
        identifier: this.limit(mac || ip, 255),
        displayName: this.limit(`${ip} (${mac})`, 255),
        vendor: null,
        model: null,
        serialNumber: null,
        isConnected: state !== 'failed' && state !== 'stale',
        metadata: {
          ip_address: ip,
          mac_address: mac,
          interface: iface,
          state,
          source: 'ip_neigh',
        },
      });
    }
  }

  private parseUnixArp(output: string, items: ConnectedDevice[]): void {
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const match = line.match(/\(([^)]+)\)\s+at\s+([0-9a-fA-F:]{17}|<incomplete>)/);
      if (!match) continue;
      const ip = match[1];
      const mac = match[2].toLowerCase();

      items.push({
        kind: 'network_neighbor',
        identifier: this.limit(mac !== '<incomplete>' ? mac : ip, 255),
        displayName: this.limit(`${ip} (${mac})`, 255),
        vendor: null,
        model: null,
        serialNumber: null,
        isConnected: mac !== '<incomplete>',
        metadata: {
          ip_address: ip,
          mac_address: mac,
          source: 'arp',
        },
      });
    }
  }

  private async enrichWindowsDisplays(displays: any[]): Promise<void> {
    if (process.platform !== 'win32' || !displays.length) {
      return;
    }

    try {
      const idCommand = 'powershell -NoProfile -Command "Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorID | Select-Object InstanceName,ManufacturerName,ProductCodeID,UserFriendlyName,SerialNumberID | ConvertTo-Json -Compress"';
      const connectionCommand = 'powershell -NoProfile -Command "Get-CimInstance -Namespace root\\wmi -ClassName WmiMonitorConnectionParams | Select-Object InstanceName,VideoOutputTechnology | ConvertTo-Json -Compress"';

      const [{ stdout: idStdout }, { stdout: connectionStdout }] = await Promise.all([
        execAsync(idCommand, { maxBuffer: 5 * 1024 * 1024 }),
        execAsync(connectionCommand, { maxBuffer: 5 * 1024 * 1024 }),
      ]);

      const idParsed = JSON.parse(idStdout || '[]');
      const monitorRows: Array<{
        instanceName?: string | null;
        manufacturer?: string | null;
        model?: string | null;
        serial?: string | null;
      }> = (Array.isArray(idParsed) ? idParsed : [idParsed])
        .map((row: any) => {
          const manufacturerCode = this.decodeWmiByteString(row?.ManufacturerName)?.toUpperCase() || null;
          const productCode = this.decodeWmiByteString(row?.ProductCodeID) || null;
          const userFriendlyName = this.decodeWmiByteString(row?.UserFriendlyName) || null;
          const serial = this.decodeWmiByteString(row?.SerialNumberID) || null;
          const instanceName = this.nullable(row?.InstanceName);
          const manufacturerName = manufacturerCode ? this.mapDisplayManufacturerCode(manufacturerCode) : null;
          const model = userFriendlyName || productCode;

          return {
            instanceName,
            manufacturer: manufacturerName,
            model,
            serial,
          };
        })
        .filter((row) => row.instanceName);

      const connectionParsed = JSON.parse(connectionStdout || '[]');
      const connectionRows: Array<{ instanceName?: string | null; videoOutputTechnology?: number }> = (
        Array.isArray(connectionParsed) ? connectionParsed : [connectionParsed]
      ).map((row: any) => ({
        instanceName: this.nullable(row?.InstanceName),
        videoOutputTechnology: Number.isFinite(Number(row?.VideoOutputTechnology))
          ? Number(row.VideoOutputTechnology)
          : undefined,
      }));

      const connectionByInstance = new Map<string, number>();
      connectionRows.forEach((row) => {
        if (!row.instanceName || row.videoOutputTechnology === undefined) {
          return;
        }
        connectionByInstance.set(this.normalizeInstanceName(row.instanceName), row.videoOutputTechnology);
      });

      const assigned = new Set<number>();
      monitorRows.forEach((monitor) => {
        const displayIndex = this.resolveDisplayIndexForMonitor(monitor.instanceName || '', displays, connectionByInstance, assigned);
        if (displayIndex === null || displayIndex < 0 || displayIndex >= displays.length) {
          return;
        }

        assigned.add(displayIndex);
        const display = displays[displayIndex];
        if (!display) {
          return;
        }

        if ((!display.vendor || this.isGenericDisplayValue(display.vendor)) && monitor.manufacturer) {
          display.vendor = monitor.manufacturer;
          display.manufacturer = monitor.manufacturer;
        }

        if ((!display.model || this.isGenericDisplayValue(display.model)) && monitor.model) {
          display.model = monitor.model;
          display.userFriendlyName = monitor.model;
        }

        if ((!display.serial || this.isGenericDisplayValue(display.serial)) && monitor.serial) {
          display.serial = monitor.serial;
          display.serialNumber = monitor.serial;
        }
      });
    } catch {
      // Best-effort enrichment only.
    }
  }

  private decodeWmiByteString(value: unknown): string | null {
    if (!Array.isArray(value)) {
      return null;
    }

    const chars = value
      .map((entry) => Number(entry))
      .filter((entry) => Number.isFinite(entry) && entry > 0)
      .map((entry) => String.fromCharCode(entry))
      .join('')
      .trim();

    return chars || null;
  }

  private mapDisplayManufacturerCode(code: string): string {
    const manufacturerMap: Record<string, string> = {
      DEL: 'Dell',
      ACI: 'ASUS',
      AUS: 'ASUS',
      GSM: 'LG',
      SAM: 'Samsung',
      LEN: 'Lenovo',
      HWP: 'HP',
      PHL: 'Philips',
      BEN: 'BenQ',
      SNY: 'Sony',
      APP: 'Apple',
      IVM: 'Iiyama',
      VSC: 'ViewSonic',
      ACR: 'Acer',
      MSI: 'MSI',
      AUO: 'AU Optronics',
    };

    return manufacturerMap[code] || code;
  }

  private normalizeInstanceName(instanceName: string): string {
    return instanceName.replace(/\0/g, '').replace(/\s+/g, '').toUpperCase();
  }

  private resolveDisplayIndexForMonitor(
    instanceName: string,
    displays: any[],
    connectionByInstance: Map<string, number>,
    assigned: Set<number>
  ): number | null {
    const normalizedInstance = this.normalizeInstanceName(instanceName);
    const uidMatch = normalizedInstance.match(/UID(\d+)_/);
    if (uidMatch && uidMatch[1]) {
      const uid = Number(uidMatch[1]);
      if (Number.isFinite(uid)) {
        const indexFromUid = uid - 256;
        if (indexFromUid >= 0 && indexFromUid < displays.length && !assigned.has(indexFromUid)) {
          return indexFromUid;
        }
      }
    }

    const videoTech = connectionByInstance.get(normalizedInstance);
    if (videoTech !== undefined) {
      const expectedConnection = this.mapVideoOutputTechnology(videoTech);
      if (expectedConnection) {
        const byConnectionIndex = displays.findIndex((display, index) => {
          if (assigned.has(index)) {
            return false;
          }

          const connection = String(display?.connection || '').toUpperCase();
          if (expectedConnection === 'INTERNAL') {
            return !!display?.builtin || connection.includes('INTERNAL') || connection.includes('EDP');
          }

          return connection.includes(expectedConnection);
        });

        if (byConnectionIndex >= 0) {
          return byConnectionIndex;
        }
      }
    }

    const firstUnassigned = displays.findIndex((_, index) => !assigned.has(index));
    return firstUnassigned >= 0 ? firstUnassigned : null;
  }

  private mapVideoOutputTechnology(value: number): string | null {
    if (value === 2147483648 || value === -2147483648) {
      return 'INTERNAL';
    }

    const map: Record<number, string> = {
      0: 'VGA',
      1: 'TV',
      2: 'COMPOSITE_VIDEO',
      3: 'SVIDEO',
      4: 'DVI',
      5: 'HDMI',
      6: 'LVDS',
      8: 'D_JPN',
      9: 'SDI',
      10: 'DISPLAYPORT',
      11: 'DISPLAYPORT',
      14: 'UDI',
      15: 'UDI',
      16: 'SDTVDONGLE',
      17: 'MIRACAST',
      18: 'INTERNAL',
      19: 'USB',
    };

    return map[value] || null;
  }

  private enrichDisplayFromEdid(display: any): void {
    try {
      const parsed = this.parseEdid(display?.edid);
      if (!parsed) {
        return;
      }

      if ((!display.vendor || this.isGenericDisplayValue(display.vendor)) && parsed.manufacturerName) {
        display.vendor = parsed.manufacturerName;
        display.manufacturer = parsed.manufacturerName;
      }

      if ((!display.model || this.isGenericDisplayValue(display.model)) && parsed.monitorName) {
        display.model = parsed.monitorName;
        display.userFriendlyName = parsed.monitorName;
      }

      if ((!display.serial || this.isGenericDisplayValue(display.serial)) && parsed.serialNumber) {
        display.serial = parsed.serialNumber;
        display.serialNumber = parsed.serialNumber;
      }

      display.edidManufacturerId = parsed.manufacturerId;
      display.edidProductCode = parsed.productCode;
      display.edidSerialNumber = parsed.serialNumber;
    } catch {
      // Best-effort enrichment only.
    }
  }

  private parseEdid(rawEdid: unknown): {
    manufacturerId: string | null;
    manufacturerName: string | null;
    productCode: string | null;
    serialNumber: string | null;
    monitorName: string | null;
  } | null {
    if (!rawEdid) {
      return null;
    }

    const hex = String(rawEdid).replace(/[^0-9a-fA-F]/g, '');
    if (hex.length < 256) {
      return null;
    }

    const bytes: number[] = [];
    for (let index = 0; index < hex.length; index += 2) {
      bytes.push(parseInt(hex.slice(index, index + 2), 16));
    }

    if (bytes.length < 128) {
      return null;
    }

    const manufacturerWord = ((bytes[8] || 0) << 8) | (bytes[9] || 0);
    const manufacturerId = String.fromCharCode(
      ((manufacturerWord >> 10) & 0x1f) + 64,
      ((manufacturerWord >> 5) & 0x1f) + 64,
      (manufacturerWord & 0x1f) + 64
    ).replace(/@/g, '').trim() || null;

    const manufacturerMap: Record<string, string> = {
      DEL: 'Dell',
      ACI: 'ASUS',
      AUS: 'ASUS',
      GSM: 'LG',
      SAM: 'Samsung',
      LEN: 'Lenovo',
      HWP: 'HP',
      PHL: 'Philips',
      BEN: 'BenQ',
      SNY: 'Sony',
      APP: 'Apple',
      IVM: 'Iiyama',
      VSC: 'ViewSonic',
      ACR: 'Acer',
      MSI: 'MSI',
      AUO: 'AU Optronics',
    };

    const productCode = this.toHexWord(bytes[10], bytes[11]);

    const serialNumeric =
      ((bytes[15] || 0) << 24) |
      ((bytes[14] || 0) << 16) |
      ((bytes[13] || 0) << 8) |
      (bytes[12] || 0);
    const serialFromNumeric = serialNumeric > 0 ? String(serialNumeric >>> 0) : null;

    let serialFromDescriptor: string | null = null;
    let monitorName: string | null = null;

    for (let offset = 54; offset <= 108; offset += 18) {
      const descriptorType = bytes[offset + 3];
      if (descriptorType === 0xff) {
        serialFromDescriptor = this.decodeDescriptorText(bytes.slice(offset + 5, offset + 18));
      }
      if (descriptorType === 0xfc) {
        monitorName = this.decodeDescriptorText(bytes.slice(offset + 5, offset + 18));
      }
    }

    const serialNumber = serialFromDescriptor || serialFromNumeric;
    const manufacturerName = manufacturerId ? manufacturerMap[manufacturerId] || manufacturerId : null;

    return {
      manufacturerId,
      manufacturerName,
      productCode,
      serialNumber,
      monitorName,
    };
  }

  private decodeDescriptorText(bytes: number[]): string | null {
    const text = bytes
      .map((value) => String.fromCharCode(value))
      .join('')
      .replace(/[\x00\x0a\x0d]/g, '')
      .trim();
    return text || null;
  }

  private toHexWord(low: number | undefined, high: number | undefined): string | null {
    if (low === undefined || high === undefined) {
      return null;
    }
    const value = ((high & 0xff) << 8) | (low & 0xff);
    if (value === 0) {
      return null;
    }
    return value.toString(16).toUpperCase().padStart(4, '0');
  }

  private isVirtualPrinter(name: string, model: unknown): boolean {
    const text = `${name} ${model ? String(model) : ''}`.toLowerCase();
    return /print to pdf|xps|onenote|fax|anydesk|software printer|virtual/.test(text);
  }

  private isPrinterConnected(status: string): boolean {
    if (!status) {
      return true;
    }

    if (/offline|error|not available|unknown/.test(status)) {
      return false;
    }

    if (/other/.test(status)) {
      return false;
    }

    return /idle|ready|normal|printing/.test(status);
  }

  private isLikelyUserBluetoothDevice(name: string): boolean {
    const normalized = name.toLowerCase();
    return !/service|transport|enumerator|protocol|rfcomm/.test(normalized);
  }

  private isGenericDisplayValue(value: unknown): boolean {
    const normalized = String(value || '').trim().toLowerCase();
    return !normalized || normalized === 'default monitor' || normalized === 'monitor';
  }

  private isGenericVendor(value: string | null): boolean {
    const normalized = (value || '').trim().toLowerCase();
    return !normalized || normalized === 'microsoft' || normalized === 'generic' || normalized === '(standard system devices)';
  }

  private isUsbInfrastructureDevice(
    displayName: string,
    model: string | null,
    deviceId: unknown,
    pnpDeviceId: string | null | undefined
  ): boolean {
    const text = `${displayName} ${model || ''}`.toLowerCase();
    const deviceIdText = `${this.nullable(deviceId) || ''} ${pnpDeviceId || ''}`.toUpperCase();

    if (deviceIdText.startsWith('PCI\\')) {
      return true;
    }

    return /root hub|host controller|xhci|port policy controller|generic usb hub|usb composite device/.test(text);
  }

  private async getDefaultGatewayIp(): Promise<string | null> {
    try {
      const gateway = await si.networkGatewayDefault();
      return gateway ? this.limit(gateway, 255) : null;
    } catch {
      return null;
    }
  }

  private async resolveMacFromArp(ipAddress: string): Promise<string | null> {
    try {
      const osInfo = await si.osInfo();
      const platform = (osInfo.platform || '').toLowerCase();
      const command = platform.includes('win') ? 'arp -a' : 'arp -a';
      const { stdout } = await execAsync(command, { maxBuffer: 5 * 1024 * 1024 });
      const ipPattern = ipAddress.replace(/\./g, '\\.');
      const regex = new RegExp(`${ipPattern}\\s+([0-9a-fA-F:-]{17})`, 'i');
      const match = stdout.match(regex);
      if (!match || !match[1]) {
        return null;
      }

      return match[1].toLowerCase().replace(/-/g, ':');
    } catch {
      return null;
    }
  }

  private async getWindowsUsbDevices(): Promise<Array<{ name: string | null; manufacturer: string | null; pnpDeviceId: string | null; vid: string | null; pid: string | null; serial: string | null }>> {
    if (process.platform !== 'win32') {
      return [];
    }

    try {
      const command = 'powershell -NoProfile -Command "Get-CimInstance Win32_PnPEntity -Filter \"PNPDeviceID LIKE \'USB%\'\" | Select-Object Name,Manufacturer,PNPDeviceID | ConvertTo-Json -Compress"';
      const { stdout } = await execAsync(command, { maxBuffer: 5 * 1024 * 1024 });
      const parsed = JSON.parse(stdout || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];

      return rows.map((row: any) => {
        const pnpDeviceId = this.nullable(row?.PNPDeviceID);
        const parsedId = this.parsePnpDeviceId(pnpDeviceId);
        return {
          name: this.nullable(row?.Name),
          manufacturer: this.nullable(row?.Manufacturer),
          pnpDeviceId,
          vid: parsedId.vid,
          pid: parsedId.pid,
          serial: parsedId.serial,
        };
      });
    } catch {
      return [];
    }
  }

  private async getWindowsBluetoothDevices(): Promise<Array<{ name: string | null; manufacturer: string | null; pnpDeviceId: string | null; serial: string | null }>> {
    if (process.platform !== 'win32') {
      return [];
    }

    try {
      const command = 'powershell -NoProfile -Command "Get-CimInstance Win32_PnPEntity -Filter \"PNPClass = \'Bluetooth\'\" | Select-Object Name,Manufacturer,PNPDeviceID | ConvertTo-Json -Compress"';
      const { stdout } = await execAsync(command, { maxBuffer: 5 * 1024 * 1024 });
      const parsed = JSON.parse(stdout || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];

      return rows.map((row: any) => {
        const pnpDeviceId = this.nullable(row?.PNPDeviceID);
        const parsedId = this.parsePnpDeviceId(pnpDeviceId);
        return {
          name: this.nullable(row?.Name),
          manufacturer: this.nullable(row?.Manufacturer),
          pnpDeviceId,
          serial: parsedId.serial,
        };
      });
    } catch {
      return [];
    }
  }

  private async getWindowsPrinters(): Promise<Array<{ name: string | null; driverName: string | null; portName: string | null; pnpDeviceId: string | null; serial: string | null; status: string | null }>> {
    if (process.platform !== 'win32') {
      return [];
    }

    try {
      const command = 'powershell -NoProfile -Command "Get-CimInstance Win32_Printer | Select-Object Name,DriverName,PortName,PNPDeviceID,PrinterStatus,WorkOffline | ConvertTo-Json -Compress"';
      const { stdout } = await execAsync(command, { maxBuffer: 5 * 1024 * 1024 });
      const parsed = JSON.parse(stdout || '[]');
      const rows = Array.isArray(parsed) ? parsed : [parsed];

      return rows.map((row: any) => {
        const pnpDeviceId = this.nullable(row?.PNPDeviceID);
        const parsedId = this.parsePnpDeviceId(pnpDeviceId);
        return {
          name: this.nullable(row?.Name),
          driverName: this.nullable(row?.DriverName),
          portName: this.nullable(row?.PortName),
          pnpDeviceId,
          serial: parsedId.serial,
          status: this.mapWindowsPrinterStatus(row?.PrinterStatus, row?.WorkOffline),
        };
      });
    } catch {
      return [];
    }
  }

  private matchWindowsUsbDevice(
    usb: any,
    windowsRows: Array<{ name: string | null; manufacturer: string | null; pnpDeviceId: string | null; vid: string | null; pid: string | null; serial: string | null }>
  ): { name: string | null; manufacturer: string | null; pnpDeviceId: string | null; vid: string | null; pid: string | null; serial: string | null } | null {
    if (!windowsRows.length) {
      return null;
    }

    const usbVid = this.normalizeHexId(usb?.vendorId);
    const usbPid = this.normalizeHexId(usb?.productId);
    const usbSerial = this.nullable(usb?.serialNumber)?.toUpperCase();
    const usbName = this.nullable(usb?.name)?.toLowerCase();

    return (
      windowsRows.find((row) => usbSerial && row.serial && row.serial.toUpperCase() === usbSerial) ||
      windowsRows.find((row) => usbVid && usbPid && row.vid === usbVid && row.pid === usbPid) ||
      windowsRows.find((row) => usbName && row.name && row.name.toLowerCase().includes(usbName)) ||
      null
    );
  }

  private matchWindowsBluetoothDevice(
    device: any,
    windowsRows: Array<{ name: string | null; manufacturer: string | null; pnpDeviceId: string | null; serial: string | null }>
  ): { name: string | null; manufacturer: string | null; pnpDeviceId: string | null; serial: string | null } | null {
    if (!windowsRows.length) {
      return null;
    }

    const deviceName = this.nullable(device?.name)?.toLowerCase();
    const address = this.nullable(device?.macDevice || device?.address)?.replace(/[^a-fA-F0-9]/g, '').toUpperCase();

    return (
      windowsRows.find((row) => address && row.pnpDeviceId && row.pnpDeviceId.replace(/[^a-fA-F0-9]/g, '').toUpperCase().includes(address)) ||
      windowsRows.find((row) => deviceName && row.name && row.name.toLowerCase().includes(deviceName)) ||
      null
    );
  }

  private matchWindowsPrinter(
    printer: any,
    windowsRows: Array<{ name: string | null; driverName: string | null; portName: string | null; pnpDeviceId: string | null; serial: string | null; status: string | null }>
  ): { name: string | null; driverName: string | null; portName: string | null; pnpDeviceId: string | null; serial: string | null; status: string | null } | null {
    if (!windowsRows.length) {
      return null;
    }

    const printerName = this.nullable(printer?.name)?.toLowerCase();
    const printerModel = this.nullable(printer?.model)?.toLowerCase();

    return (
      windowsRows.find((row) => printerName && row.name && row.name.toLowerCase() === printerName) ||
      windowsRows.find((row) => printerName && row.name && row.name.toLowerCase().includes(printerName)) ||
      windowsRows.find((row) => printerModel && row.driverName && row.driverName.toLowerCase().includes(printerModel)) ||
      null
    );
  }

  private parsePnpDeviceId(value: string | null): { vid: string | null; pid: string | null; serial: string | null } {
    if (!value) {
      return { vid: null, pid: null, serial: null };
    }

    const normalized = value.toUpperCase();
    const vid = normalized.match(/VID_([0-9A-F]{4})/)?.[1] || null;
    const pid = normalized.match(/PID_([0-9A-F]{4})/)?.[1] || null;
    const serialCandidate = normalized.split('\\').pop() || null;
    const serial = serialCandidate && !serialCandidate.includes('&') ? serialCandidate : null;

    return { vid, pid, serial };
  }

  private normalizeHexId(value: unknown): string | null {
    const normalized = this.nullable(value)?.toUpperCase() || null;
    if (!normalized) {
      return null;
    }

    const match = normalized.match(/([0-9A-F]{4})$/);
    return match ? match[1] : null;
  }

  private mapUsbVendorByVid(vid: string | null): string | null {
    if (!vid) {
      return null;
    }

    const map: Record<string, string> = {
      '046D': 'Logitech',
      '0B05': 'ASUS',
      '05E3': 'Genesys Logic',
      '1A40': 'Terminus Technology',
      '1D57': 'Xenta',
      '8087': 'Intel',
      '2109': 'VIA Labs',
      '0951': 'Kingston',
      '0781': 'SanDisk',
      '18A5': 'Verbatim',
      '1532': 'Razer',
      '054C': 'Sony',
      '04E8': 'Samsung',
      '2E17': 'Xiaomi',
      '04F2': 'Chicony',
      '0CF3': 'Qualcomm Atheros',
      '0A5C': 'Broadcom',
      '17EF': 'Lenovo',
      '03F0': 'HP',
      '04A9': 'Canon',
      '04B8': 'Epson',
      '04F9': 'Brother',
    };

    return map[vid] || null;
  }

  private mapWindowsPrinterStatus(status: unknown, workOffline: unknown): string | null {
    if (workOffline === true) {
      return 'offline';
    }

    const numericStatus = Number(status);
    if (!Number.isFinite(numericStatus)) {
      return null;
    }

    const map: Record<number, string> = {
      1: 'other',
      2: 'unknown',
      3: 'idle',
      4: 'printing',
      5: 'warmup',
      6: 'stopped_printing',
      7: 'offline',
    };

    return map[numericStatus] || null;
  }

  private extractVendorFromText(...values: unknown[]): string | null {
    const text = values
      .map((value) => this.nullable(value))
      .filter((value): value is string => !!value)
      .join(' ')
      .toLowerCase();

    if (!text) {
      return null;
    }

    const knownVendors = [
      'hp',
      'hewlett packard',
      'canon',
      'epson',
      'brother',
      'lexmark',
      'xerox',
      'ricoh',
      'kyocera',
      'samsung',
      'dell',
      'konica',
      'sharp',
      'oki',
      'pantum',
      'fuji',
      'jbl',
      'keychron',
      'soundcore',
      'redmi',
      'xiaomi',
      'anker',
      'lenyes',
      'robot',
    ];

    const matched = knownVendors.find((vendor) => text.includes(vendor));
    if (!matched) {
      return null;
    }

    if (matched === 'hewlett packard' || matched === 'hp') {
      return 'HP';
    }

    if (matched === 'soundcore' || matched === 'anker') {
      return 'Anker';
    }

    if (matched === 'redmi' || matched === 'xiaomi') {
      return 'Xiaomi';
    }

    if (matched === 'jbl') {
      return 'JBL';
    }

    return matched
      .split(' ')
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join(' ');
  }

  private extractModelFromText(...values: unknown[]): string | null {
    const candidates = values
      .map((value) => this.nullable(value))
      .filter((value): value is string => !!value);

    for (const candidate of candidates) {
      const normalized = candidate.replace(/\s+/g, ' ').trim();
      if (!normalized) {
        continue;
      }

      if (!/default|generic|microsoft|class driver/i.test(normalized)) {
        return normalized;
      }
    }

    return candidates[0] || null;
  }

  private inferVendorFromMac(macAddress: string): string | null {
    const prefix = macAddress
      .toUpperCase()
      .replace(/[^0-9A-F]/g, '')
      .slice(0, 6);

    if (prefix.length < 6) {
      return null;
    }

    const ouiMap: Record<string, string> = {
      'F4F26D': 'TP-Link',
      'C83A35': 'TP-Link',
      'B0487A': 'TP-Link',
      'FC3497': 'Ubiquiti',
      '24A43C': 'Ubiquiti',
      '001A11': 'Cisco',
      'A44CC8': 'Cisco',
      '485D60': 'MikroTik',
      'D4CA6D': 'MikroTik',
      'C43DC7': 'ASUS',
      '049226': 'ASUS',
      'F8A9D0': 'Huawei',
      '04C06F': 'Huawei',
      '2C3AFD': 'Netgear',
      '9CC9EB': 'Netgear',
      '34CE00': 'D-Link',
      '1C7EE5': 'D-Link',
      '5CC7D7': 'Tenda',
      '9C3DCF': 'ZTE',
      '28285D': 'ZTE',
    };

    return ouiMap[prefix] || null;
  }

  private nullable(value: unknown): string | null {
    if (value === undefined || value === null) {
      return null;
    }
    const normalized = String(value).trim();
    if (!normalized) {
      return null;
    }
    return this.limit(normalized, 255);
  }

  private limit(value: unknown, length: number): string {
    const normalized = value === undefined || value === null ? '' : String(value);
    if (normalized.length <= length) {
      return normalized;
    }
    return normalized.substring(0, length);
  }
}
