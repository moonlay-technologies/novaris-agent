import { EvidenceContext, EvidencePack } from '../evidencePack';
import { failed, fromFailure, ok, unknown } from '../evidenceItem';
import { EncryptionItems, EvidenceItem, OtherVolumesValue, SystemVolumeValue } from '../../types/evidence';

interface BitlockerRow {
  drive_letter?: string;
  conversion_status?: string | number;
  protection_status?: string | number;
  encryption_method?: string;
  percentage_encrypted?: string | number;
}

/** Parses `manage-bde -status C:` (English output). */
export function parseManageBde(stdout: string): SystemVolumeValue | null {
  const field = (label: string) => stdout.match(new RegExp(`${label}:\\s*(.+)`, 'i'))?.[1].trim() ?? null;
  const conversion = field('Conversion Status');
  const protection = field('Protection Status');
  if (!conversion || !protection) return null;
  const method = field('Encryption Method');
  return {
    volume: field('Volume') ?? 'C:',
    encrypted: /fully encrypted/i.test(conversion),
    method: method && !/none/i.test(method) ? method : null,
    protection_on: /protection on/i.test(protection),
  };
}

/** Encryption & Data Protection: system volume first, other fixed volumes as a count. Recovery material is never read. */
export class EncryptionPack implements EvidencePack<'encryption'> {
  readonly category = 'encryption' as const;

  constructor(private readonly systemDrive: () => string = () => (process.env.SystemDrive || 'C:').toUpperCase()) {}

  async collect(context: EvidenceContext): Promise<EncryptionItems> {
    switch (context.platform) {
      case 'windows':
        return this.windows(context);
      case 'macos':
        return { system_volume: await this.mac(context) };
      case 'linux':
        return { system_volume: await this.linux(context) };
    }
  }

  private async windows(context: EvidenceContext): Promise<EncryptionItems> {
    const drive = this.systemDrive();
    const query = await context.osquery.query<BitlockerRow>(
      'SELECT drive_letter, conversion_status, protection_status, encryption_method, percentage_encrypted FROM bitlocker_info',
    );

    if (query.ok) {
      const source = 'osquery:bitlocker_info';
      // bitlocker_info needs administrator rights; without them it returns no rows
      if (query.rows.length === 0 && !context.elevated) {
        const item = unknown<never>(source, 'insufficient_privilege', 'bitlocker_info requires administrator rights');
        return { system_volume: item, other_volumes: item };
      }
      const toVolume = (row: BitlockerRow): SystemVolumeValue => ({
        volume: String(row.drive_letter || drive).toUpperCase(),
        encrypted: String(row.conversion_status) === '1' || Number(row.percentage_encrypted) >= 100,
        method: row.encryption_method && !/^none$/i.test(String(row.encryption_method)) ? String(row.encryption_method) : null,
        protection_on: String(row.protection_status) === '1',
      });
      const volumes = query.rows.map(toVolume);
      const system = volumes.find((volume) => volume.volume === drive) ?? { volume: drive, encrypted: false, method: null, protection_on: false };
      const others = volumes.filter((volume) => volume.volume !== drive);
      return {
        system_volume: ok(source, system),
        other_volumes: ok<OtherVolumesValue>(source, { total: others.length, encrypted: others.filter((volume) => volume.encrypted).length }),
      };
    }

    // osquery missing or failing: manage-bde ships with Windows
    const source = 'cli:manage-bde';
    const bde = await context.runner.run('manage-bde', ['-status', drive], { timeoutMs: 30000 });
    if (!bde.ok) return { system_volume: fromFailure(source, bde, context.elevated) };
    const parsed = parseManageBde(bde.stdout);
    return { system_volume: parsed ? ok(source, { ...parsed, volume: drive }) : failed(source, 'parse_error', 'unrecognised manage-bde output') };
  }

  private async mac(context: EvidenceContext): Promise<EvidenceItem<SystemVolumeValue>> {
    const source = 'cli:fdesetup';
    const result = await context.runner.run('fdesetup', ['status'], { timeoutMs: 15000 });
    if (!result.ok) return fromFailure(source, result, context.elevated);
    if (!/FileVault is (On|Off)/i.test(result.stdout)) return failed(source, 'parse_error', 'unrecognised fdesetup output');
    const on = /FileVault is On/i.test(result.stdout);
    return ok(source, { volume: '/', encrypted: on, method: on ? 'FileVault' : null, protection_on: null });
  }

  private async linux(context: EvidenceContext): Promise<EvidenceItem<SystemVolumeValue>> {
    const source = 'cli:findmnt,lsblk';
    const mount = await context.runner.run('findmnt', ['-n', '-o', 'SOURCE', '/'], { timeoutMs: 10000 });
    if (!mount.ok) return fromFailure(source, mount, context.elevated);
    // Btrfs subvolumes show as "/dev/nvme0n1p3[/@]"
    const device = mount.stdout.trim().replace(/\[.*\]$/, '');
    if (!device.startsWith('/dev/')) return unknown(source, 'not_detected', `root is not a block device (${device.split('/').pop()})`);

    // -s walks from the root device down to its parents, so LUKS under LVM is found too
    const tree = await context.runner.run('lsblk', ['-s', '-n', '-r', '-o', 'NAME,TYPE', device], { timeoutMs: 10000 });
    if (!tree.ok) return fromFailure(source, tree, context.elevated);
    const encrypted = tree.stdout.split(/\r?\n/).some((line) => line.trim().split(/\s+/)[1] === 'crypt');
    return ok(source, { volume: '/', encrypted, method: encrypted ? 'LUKS' : null, protection_on: null });
  }
}
