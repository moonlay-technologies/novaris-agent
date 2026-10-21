import * as os from 'os';
import * as si from 'systeminformation';
import { EvidenceContext, EvidencePack } from '../evidencePack';
import { cleanHardwareString, fromException, fromFailure, ok, unknown } from '../evidenceItem';
import { EvidenceItem, IdentityDeviceValue, IdentityItems, IdentityManagementValue, JoinType } from '../../types/evidence';

/** The parts of systeminformation the identity pack reads (replaceable in tests). */
export interface IdentitySource {
  osInfo(): Promise<{ distro: string; release: string; build: string; arch: string; hostname: string }>;
  system(): Promise<{ manufacturer: string; model: string; serial: string }>;
  defaultInterface(): Promise<{ ip4: string; mac: string } | null>;
  hostname(): string;
}

export const systemInformationSource: IdentitySource = {
  osInfo: () => si.osInfo(),
  system: () => si.system(),
  async defaultInterface() {
    const iface = await si.networkInterfaces('default');
    const single = Array.isArray(iface) ? iface[0] : iface;
    return single ? { ip4: single.ip4, mac: single.mac } : null;
  },
  hostname: () => os.hostname(),
};

const DEVICE_SOURCE = 'systeminformation:osInfo,system,networkInterfaces';

/** Windows edition from the product name, e.g. "Microsoft Windows 11 Pro" -> "Pro". */
function windowsEdition(osName: string): string | null {
  const match = osName.match(/Windows\s+(?:Server\s+)?\d+\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

export class IdentityPack implements EvidencePack<'identity'> {
  readonly category = 'identity' as const;

  constructor(private readonly source: IdentitySource = systemInformationSource) {}

  async collect(context: EvidenceContext): Promise<IdentityItems> {
    const [device, management] = await Promise.all([this.collectDevice(context), this.collectManagement(context)]);
    return { device, management };
  }

  private async collectDevice(context: EvidenceContext): Promise<EvidenceItem<IdentityDeviceValue>> {
    try {
      const [osInfo, system, iface] = await Promise.all([
        this.source.osInfo(),
        this.source.system(),
        this.source.defaultInterface().catch(() => null),
      ]);

      const osName = String(osInfo.distro || '').trim();
      const osVersion = String(osInfo.release || '').trim();
      if (!osName || !osVersion) {
        return unknown(DEVICE_SOURCE, 'not_detected', 'OS name or version not reported');
      }

      return ok(DEVICE_SOURCE, {
        hostname: (osInfo.hostname || this.source.hostname()).slice(0, 255),
        // DMI serial on Linux needs root; an empty value then means "not readable", reported as null
        serial_number: cleanHardwareString(system.serial),
        manufacturer: cleanHardwareString(system.manufacturer),
        model: cleanHardwareString(system.model),
        os_family: context.platform,
        os_name: osName.slice(0, 100),
        os_version: osVersion.slice(0, 50),
        os_build: cleanHardwareString(osInfo.build),
        os_edition: context.platform === 'windows' ? windowsEdition(osName) : null,
        arch: cleanHardwareString(osInfo.arch),
        primary_ip: cleanHardwareString(iface?.ip4),
        primary_mac: cleanHardwareString(iface?.mac),
      });
    } catch (error) {
      return fromException(DEVICE_SOURCE, error);
    }
  }

  private async collectManagement(context: EvidenceContext): Promise<EvidenceItem<IdentityManagementValue>> {
    switch (context.platform) {
      case 'windows':
        return this.windowsManagement(context);
      case 'macos':
        return this.macManagement(context);
      case 'linux':
        return this.linuxManagement(context);
    }
  }

  private async windowsManagement(context: EvidenceContext): Promise<EvidenceItem<IdentityManagementValue>> {
    const source = 'cli:dsregcmd';
    const result = await context.runner.run('dsregcmd', ['/status'], { timeoutMs: 20000 });
    if (!result.ok) return fromFailure(source, result, context.elevated);
    return ok(source, parseDsregcmd(result.stdout));
  }

  private async macManagement(context: EvidenceContext): Promise<EvidenceItem<IdentityManagementValue>> {
    const source = 'cli:profiles,dsconfigad';
    const profiles = await context.runner.run('profiles', ['status', '-type', 'enrollment'], { timeoutMs: 20000 });
    if (!profiles.ok) return fromFailure(source, profiles, context.elevated);

    const mdmLine = profiles.stdout.split(/\r?\n/).find((line) => /^MDM enrollment:/i.test(line.trim()));
    const mdmEnrolled = mdmLine ? /:\s*yes/i.test(mdmLine) : null;

    // dsconfigad prints nothing when the Mac is not bound to Active Directory
    const ad = await context.runner.run('dsconfigad', ['-show'], { timeoutMs: 10000 });
    const joinType: JoinType = ad.ok ? (ad.stdout.trim() ? 'domain' : 'none') : 'unknown';

    return ok(source, { join_type: joinType, mdm_enrolled: mdmEnrolled, mdm_server: null });
  }

  private async linuxManagement(context: EvidenceContext): Promise<EvidenceItem<IdentityManagementValue>> {
    const source = 'cli:realm';
    const result = await context.runner.run('realm', ['list', '--name-only'], { timeoutMs: 10000 });
    if (!result.ok) return fromFailure(source, result, context.elevated);
    const joined = result.stdout.split(/\r?\n/).some((line) => line.trim().length > 0);
    return ok(source, { join_type: joined ? 'realm' : 'none', mdm_enrolled: null, mdm_server: null });
  }
}

/** Parses `dsregcmd /status` ("Name : VALUE" lines). */
export function parseDsregcmd(stdout: string): IdentityManagementValue {
  const values = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/);
    if (match && !values.has(match[1].toLowerCase())) {
      values.set(match[1].toLowerCase(), match[2]);
    }
  }

  const entra = values.get('azureadjoined')?.toUpperCase() === 'YES';
  const domain = values.get('domainjoined')?.toUpperCase() === 'YES';
  const joinType: JoinType = entra && domain ? 'hybrid' : entra ? 'entra' : domain ? 'domain' : 'none';

  const mdmUrl = values.get('mdmurl') || '';
  let mdmServer: string | null = null;
  if (mdmUrl) {
    try {
      const host = new URL(mdmUrl).hostname;
      mdmServer = /manage\.microsoft\.com$/i.test(host) ? 'Microsoft Intune' : host;
    } catch {
      mdmServer = null;
    }
  }

  return {
    join_type: joinType,
    // dsregcmd lists the MDM URL only for Entra-joined devices; otherwise enrollment is not visible here
    mdm_enrolled: mdmUrl ? true : entra ? false : null,
    mdm_server: mdmServer,
  };
}
