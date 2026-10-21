import { EvidenceContext, EvidencePack } from '../evidencePack';
import { fromFailure, ok } from '../evidenceItem';
import { LINUX_PRODUCTS, MAC_PRODUCTS, KnownProduct, windowsProductKind } from '../knownProducts';
import { runAccepting, runPowerShellJson, toInt, wholeDaysBetween } from '../probes';
import { AntimalwareProduct, AntimalwareValue, EvidenceItem, ProtectionItems } from '../../types/evidence';

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$mp = $null
try { $mp = Get-MpComputerStatus } catch {}
$sc = @()
try { $sc = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | Select-Object displayName, productState) } catch {}
[pscustomobject]@{
  defender = $(if ($mp) { [pscustomobject]@{
    realtime = [bool]$mp.RealTimeProtectionEnabled
    signature_age = [int]$mp.AntivirusSignatureAge
    tamper = [bool]$mp.IsTamperProtected
    mode = [string]$mp.AMRunningMode
  } } else { $null })
  products = $sc
} | ConvertTo-Json -Compress -Depth 4
`.trim();

interface WindowsProtectionJson {
  defender: { realtime: boolean; signature_age: number; tamper: boolean; mode: string } | null;
  products: Array<{ displayName?: string; productState?: number }> | { displayName?: string; productState?: number } | null;
}

const XPROTECT_PLIST = '/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist';

/**
 * Decodes Windows Security Center's productState: the middle byte is the engine
 * state (0x10/0x11 = on), the low byte the definition state (0x00 = up to date).
 */
export function decodeProductState(state: unknown): { realtime: boolean | null; upToDate: boolean | null } {
  const value = Number(state);
  if (!Number.isFinite(value)) return { realtime: null, upToDate: null };
  const hex = value.toString(16).padStart(6, '0');
  const engine = hex.slice(2, 4);
  return { realtime: engine === '10' || engine === '11', upToDate: hex.slice(4, 6) === '00' };
}

/** Endpoint Protection: anti-malware / EDR presence, real-time state and definition age. */
export class ProtectionPack implements EvidencePack<'protection'> {
  readonly category = 'protection' as const;

  async collect(context: EvidenceContext): Promise<ProtectionItems> {
    switch (context.platform) {
      case 'windows':
        return { antimalware: await this.windows(context) };
      case 'macos':
        return { antimalware: await this.mac(context) };
      case 'linux':
        return { antimalware: await this.linux(context) };
    }
  }

  private async windows(context: EvidenceContext): Promise<EvidenceItem<AntimalwareValue>> {
    const source = 'powershell:Get-MpComputerStatus,SecurityCenter2';
    const probe = await runPowerShellJson<WindowsProtectionJson>(context, WINDOWS_SCRIPT);
    if (!probe.ok) return fromFailure(source, probe, context.elevated);

    const defender = probe.data.defender;
    const registered = probe.data.products === null ? [] : Array.isArray(probe.data.products) ? probe.data.products : [probe.data.products];
    const products: AntimalwareProduct[] = [];

    for (const entry of registered) {
      const name = String(entry.displayName || '').trim();
      if (!name) continue;
      const state = decodeProductState(entry.productState);
      const product: AntimalwareProduct = {
        name: name.slice(0, 255),
        kind: windowsProductKind(name),
        realtime_enabled: state.realtime,
        signatures_up_to_date: state.upToDate,
        signature_age_days: null,
        tamper_protected: null,
      };
      if (defender && /defender/i.test(name)) Object.assign(product, this.defenderDetails(defender));
      products.push(product);
    }

    // Windows Server has no Security Center: report Defender from its own status
    if (defender && !products.some((product) => /defender/i.test(product.name))) {
      products.push({ name: 'Microsoft Defender Antivirus', kind: 'av', signatures_up_to_date: null, ...this.defenderDetails(defender) });
    }

    return ok(source, { products, gatekeeper_enabled: null });
  }

  private defenderDetails(defender: NonNullable<WindowsProtectionJson['defender']>): Pick<AntimalwareProduct, 'realtime_enabled' | 'signature_age_days' | 'tamper_protected'> {
    // In passive mode another product is primary; Defender's own engine does not block in real time
    const passive = /passive/i.test(defender.mode || '');
    return {
      realtime_enabled: Boolean(defender.realtime) && !passive,
      signature_age_days: toInt(defender.signature_age),
      tamper_protected: Boolean(defender.tamper),
    };
  }

  private async mac(context: EvidenceContext): Promise<EvidenceItem<AntimalwareValue>> {
    const source = 'cli:spctl;plist:XProtect;processes';
    // spctl exits 1 when assessments are disabled
    const spctl = await runAccepting(context, 'spctl', ['--status'], [1], 15000);
    const gatekeeper = spctl.ok ? /assessments enabled/i.test(`${spctl.stdout}${spctl.stderr}`) : null;

    const products: AntimalwareProduct[] = [];
    const xprotectUpdated = await context.files.modifiedAt(XPROTECT_PLIST);
    products.push({
      name: 'XProtect',
      kind: 'builtin',
      // XProtect cannot be switched off on supported macOS versions; it is present if its bundle is
      realtime_enabled: xprotectUpdated ? true : null,
      signatures_up_to_date: null,
      signature_age_days: xprotectUpdated ? wholeDaysBetween(xprotectUpdated, context.now()) : null,
      tamper_protected: null,
    });

    const running = await this.runningProcesses(context);
    if (!running.ok) return fromFailure(source, running.failure, context.elevated);
    products.push(...this.matchKnown(MAC_PRODUCTS, running.names));

    return ok(source, { products, gatekeeper_enabled: gatekeeper });
  }

  private async linux(context: EvidenceContext): Promise<EvidenceItem<AntimalwareValue>> {
    const source = 'processes';
    const running = await this.runningProcesses(context);
    if (!running.ok) return fromFailure(source, running.failure, context.elevated);

    const products = this.matchKnown(LINUX_PRODUCTS.filter((product) => product.name !== 'ClamAV'), running.names);

    const clamRunning = running.names.has('clamd') || running.names.has('clamonacc');
    if (clamRunning) {
      const definitions = (await context.files.modifiedAt('/var/lib/clamav/daily.cld')) ?? (await context.files.modifiedAt('/var/lib/clamav/daily.cvd'));
      products.push({
        name: 'ClamAV',
        kind: 'av',
        // clamd alone only scans on request; on-access scanning needs clamonacc
        realtime_enabled: running.names.has('clamonacc'),
        signatures_up_to_date: null,
        signature_age_days: definitions ? wholeDaysBetween(definitions, context.now()) : null,
        tamper_protected: null,
      });
    }

    return ok(source, { products, gatekeeper_enabled: null });
  }

  private matchKnown(known: KnownProduct[], running: Set<string>): AntimalwareProduct[] {
    return known
      .filter((product) => product.processes.some((name) => running.has(name.toLowerCase())))
      .map((product) => ({
        name: product.name,
        kind: product.kind,
        realtime_enabled: true,
        signatures_up_to_date: null,
        signature_age_days: null,
        tamper_protected: null,
      }));
  }

  /** Names (lower-case) of running executables: osquery first, `ps` as fallback. Names only, never arguments. */
  private async runningProcesses(
    context: EvidenceContext,
  ): Promise<{ ok: true; names: Set<string> } | { ok: false; failure: Parameters<typeof fromFailure>[1] }> {
    const query = await context.osquery.query<{ name: string }>('SELECT DISTINCT name FROM processes');
    if (query.ok) return { ok: true, names: new Set(query.rows.map((row) => String(row.name).toLowerCase())) };

    const ps = await context.runner.run('ps', ['-A', '-o', 'comm='], { timeoutMs: 15000 });
    if (!ps.ok) return { ok: false, failure: ps };
    const names = ps.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split('/').pop() || '')
      .filter(Boolean)
      .map((name) => name.toLowerCase());
    return { ok: true, names: new Set(names) };
  }
}
