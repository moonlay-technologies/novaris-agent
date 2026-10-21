import { EvidenceContext, EvidencePack } from '../evidencePack';
import { failed, fromFailure, ok, unknown } from '../evidenceItem';
import { runAccepting, runPowerShellJson } from '../probes';
import { BaselineSettings, EvidenceItem, HardeningItems, SecureBootValue, TpmValue } from '../../types/evidence';

const WINDOWS_SECURE_BOOT_SCRIPT = `
try { [pscustomobject]@{ supported = $true; enabled = [bool](Confirm-SecureBootUEFI); error = $null } | ConvertTo-Json -Compress }
catch [System.PlatformNotSupportedException] { [pscustomobject]@{ supported = $false; enabled = $null; error = $null } | ConvertTo-Json -Compress }
catch { [pscustomobject]@{ supported = $null; enabled = $null; error = [string]$_.Exception.Message } | ConvertTo-Json -Compress }
`.trim();

const WINDOWS_TPM_SCRIPT = `
$ErrorActionPreference = 'Stop'
$t = Get-Tpm
$spec = $null
try { $spec = ([string](Get-CimInstance -Namespace root/cimv2/Security/MicrosoftTpm -ClassName Win32_Tpm).SpecVersion).Split(',')[0].Trim() } catch {}
[pscustomobject]@{ present = [bool]$t.TpmPresent; ready = [bool]$t.TpmReady; version = $spec } | ConvertTo-Json -Compress
`.trim();

const WINDOWS_BASELINE_SCRIPT = `
$ErrorActionPreference = 'Stop'
$smb1 = $null
try { $smb1 = [bool](Get-SmbServerConfiguration).EnableSMB1Protocol } catch {}
$explorer = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\Explorer' -ErrorAction SilentlyContinue
$dns = Get-ItemProperty 'HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient' -ErrorAction SilentlyContinue
$system = Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue
[pscustomobject]@{
  smb1 = $smb1
  autorun = $(if ($explorer -and $explorer.NoDriveTypeAutoRun -ne $null) { [int]$explorer.NoDriveTypeAutoRun } else { $null })
  llmnr = $(if ($dns -and $dns.EnableMulticast -ne $null) { [int]$dns.EnableMulticast } else { $null })
  uac = $(if ($system -and $system.EnableLUA -ne $null) { [int]$system.EnableLUA } else { $null })
} | ConvertTo-Json -Compress
`.trim();

interface WindowsBaselineJson {
  smb1: boolean | null;
  autorun: number | null;
  llmnr: number | null;
  uac: number | null;
}

/** Hardening & Boot Integrity: Secure Boot, TPM and a small, versioned set of OS settings. */
export class HardeningPack implements EvidencePack<'hardening'> {
  readonly category = 'hardening' as const;

  async collect(context: EvidenceContext): Promise<HardeningItems> {
    const secure_boot = await this.secureBoot(context);
    switch (context.platform) {
      case 'windows':
        return { secure_boot, tpm: await this.windowsTpm(context), baseline: await this.windowsBaseline(context) };
      case 'macos':
        return { secure_boot, baseline: await this.macBaseline(context) };
      case 'linux':
        return { secure_boot, baseline: await this.linuxBaseline(context) };
    }
  }

  private async secureBoot(context: EvidenceContext): Promise<EvidenceItem<SecureBootValue>> {
    const query = await context.osquery.query<{ secure_boot: string }>('SELECT secure_boot FROM secureboot');
    if (query.ok && query.rows.length) {
      return ok('osquery:secureboot', { supported: true, enabled: Number(query.rows[0].secure_boot) > 0 });
    }

    if (context.platform === 'windows') {
      const source = 'powershell:Confirm-SecureBootUEFI';
      const probe = await runPowerShellJson<{ supported: boolean | null; enabled: boolean | null; error: string | null }>(context, WINDOWS_SECURE_BOOT_SCRIPT, 20000);
      if (!probe.ok) return fromFailure(source, probe, context.elevated);
      if (probe.data.supported === null) {
        return context.elevated ? failed(source, 'command_failed', probe.data.error) : unknown(source, 'insufficient_privilege', probe.data.error);
      }
      return ok(source, { supported: probe.data.supported, enabled: probe.data.enabled });
    }

    if (context.platform === 'linux') {
      const source = 'cli:mokutil;file:/sys/firmware/efi';
      if (!(await context.files.exists('/sys/firmware/efi'))) return ok(source, { supported: false, enabled: null });
      const mok = await context.runner.run('mokutil', ['--sb-state'], { timeoutMs: 10000 });
      if (mok.ok) return ok(source, { supported: true, enabled: /secureboot enabled/i.test(mok.stdout) });
      return fromFailure(source, mok, context.elevated);
    }

    return query.ok ? unknown('osquery:secureboot', 'not_detected', 'secure boot state not reported on this Mac') : fromFailure('osquery:secureboot', query, context.elevated);
  }

  private async windowsTpm(context: EvidenceContext): Promise<EvidenceItem<TpmValue>> {
    const query = await context.osquery.query<{ activated: string; enabled: string; spec_version: string }>('SELECT activated, enabled, spec_version FROM tpm_info');
    if (query.ok && query.rows.length) {
      const row = query.rows[0];
      return ok('osquery:tpm_info', { present: true, ready: row.activated === '1' && row.enabled === '1', version: row.spec_version || null });
    }

    const source = 'powershell:Get-Tpm';
    const probe = await runPowerShellJson<{ present: boolean; ready: boolean; version: string | null }>(context, WINDOWS_TPM_SCRIPT, 20000);
    if (!probe.ok) return fromFailure(source, probe, context.elevated);
    return ok(source, { present: probe.data.present, ready: probe.data.present ? probe.data.ready : null, version: probe.data.version });
  }

  private async windowsBaseline(context: EvidenceContext): Promise<EvidenceItem<{ settings: BaselineSettings }>> {
    const source = 'powershell:Get-SmbServerConfiguration,registry';
    const probe = await runPowerShellJson<WindowsBaselineJson>(context, WINDOWS_BASELINE_SCRIPT, 30000);
    if (!probe.ok) return fromFailure(source, probe, context.elevated);
    const { smb1, autorun, llmnr, uac } = probe.data;
    return ok(source, {
      settings: {
        'windows.smb1_enabled': smb1,
        // 255 (0xFF) disables AutoRun on every drive type
        'windows.autorun_disabled': autorun === null ? false : autorun === 255,
        'windows.llmnr_disabled': llmnr === null ? false : llmnr === 0,
        'windows.uac_enabled': uac === null ? true : uac === 1,
      },
    });
  }

  private async macBaseline(context: EvidenceContext): Promise<EvidenceItem<{ settings: BaselineSettings }>> {
    const csrutil = await context.runner.run('csrutil', ['status'], { timeoutMs: 10000 });
    // spctl exits 1 when assessments are disabled
    const spctl = await runAccepting(context, 'spctl', ['--status'], [1], 10000);
    if (!csrutil.ok && !spctl.ok) return fromFailure('cli:csrutil,spctl', csrutil, context.elevated);
    return ok('cli:csrutil,spctl', {
      settings: {
        'macos.sip_enabled': csrutil.ok ? /status:\s*enabled/i.test(csrutil.stdout) : null,
        'macos.gatekeeper_enabled': spctl.ok ? /assessments enabled/i.test(`${spctl.stdout}${spctl.stderr}`) : null,
      },
    });
  }

  private async linuxBaseline(context: EvidenceContext): Promise<EvidenceItem<{ settings: BaselineSettings }>> {
    const source = 'file:/proc/sys/kernel';
    const aslr = await context.files.readText('/proc/sys/kernel/randomize_va_space', 64);
    if (aslr === null) return unknown(source, 'not_detected', 'kernel settings not readable');
    return ok(source, { settings: { 'linux.aslr_full': aslr.trim() === '2' } });
  }
}

