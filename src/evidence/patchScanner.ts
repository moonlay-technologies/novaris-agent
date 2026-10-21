import { EvidenceContext } from './evidencePack';
import { ProbeFailure, parseDate, runAccepting, runPowerShellJson, toInt, wholeDaysBetween } from './probes';
import { PackageManager } from '../types/evidence';

/** What one scan of the OS update source found. Shared by the patch evidence pack and the legacy patch report. */
export interface PatchScan {
  packageManager: PackageManager;
  pendingTotal: number;
  pendingSecurity: number;
  oldestPendingSecurityDays: number | null;
  lastScanAt: Date | null;
  lastInstalledAt: Date | null;
  /** null = this platform does not expose a staged-update reboot state. */
  rebootPending: boolean | null;
  sampleTitles: string[];
}

export type PatchScanResult = { ok: true; scan: PatchScan } | { ok: false; source: string; failure: ProbeFailure };

/** Windows Update category ids (stable across OS languages, unlike the names). */
const WU_SECURITY_CATEGORY = '0fa1201d-4330-4fa8-8ae9-b877473b6441';
const WU_CRITICAL_CATEGORY = 'e6cf1350-c01b-414d-a61f-263d14d133b4';

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$session = New-Object -ComObject Microsoft.Update.Session
$searcher = $session.CreateUpdateSearcher()
$result = $searcher.Search("IsInstalled=0 and IsHidden=0 and Type='Software'")
$pending = $result.Updates.Count
$security = 0
$oldest = $null
$titles = @()
foreach ($u in $result.Updates) {
  if ($titles.Count -lt 5) { $titles += $u.Title }
  $ids = @($u.Categories | ForEach-Object { ([string]$_.CategoryID).ToLower() })
  if ($ids -contains '${WU_SECURITY_CATEGORY}' -or $ids -contains '${WU_CRITICAL_CATEGORY}') {
    $security++
    $d = $u.LastDeploymentChangeTime
    if ($d -and ($oldest -eq $null -or $d -lt $oldest)) { $oldest = $d }
  }
}
$lastInstall = $null
$count = $searcher.GetTotalHistoryCount()
if ($count -gt 0) {
  foreach ($h in $searcher.QueryHistory(0, [Math]::Min($count, 100))) {
    if ($h.Operation -eq 1 -and $h.ResultCode -eq 2 -and ($lastInstall -eq $null -or $h.Date -gt $lastInstall)) { $lastInstall = $h.Date }
  }
}
$reboot = $false
try { $reboot = [bool](New-Object -ComObject Microsoft.Update.SystemInfo).RebootRequired } catch {}
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired') { $reboot = $true }
if (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') { $reboot = $true }
[pscustomobject]@{
  pending = $pending
  security = $security
  oldest = $(if ($oldest) { $oldest.ToUniversalTime().ToString('o') } else { $null })
  last_install = $(if ($lastInstall) { $lastInstall.ToUniversalTime().ToString('o') } else { $null })
  reboot = $reboot
  titles = $titles
} | ConvertTo-Json -Compress
`.trim();

interface WindowsScanJson {
  pending: number;
  security: number;
  oldest: string | null;
  last_install: string | null;
  reboot: boolean;
  titles: string[] | string | null;
}

export class PatchScanner {
  async scan(context: EvidenceContext): Promise<PatchScanResult> {
    switch (context.platform) {
      case 'windows':
        return this.scanWindows(context);
      case 'macos':
        return this.scanMac(context);
      case 'linux':
        return this.scanLinux(context);
    }
  }

  private async scanWindows(context: EvidenceContext): Promise<PatchScanResult> {
    const probe = await runPowerShellJson<WindowsScanJson>(context, WINDOWS_SCRIPT, 180000);
    if (!probe.ok) return { ok: false, source: 'com:Microsoft.Update.Session', failure: probe };

    const now = context.now();
    const oldest = parseDate(probe.data.oldest);
    const titles = probe.data.titles === null ? [] : Array.isArray(probe.data.titles) ? probe.data.titles : [probe.data.titles];
    return {
      ok: true,
      scan: {
        packageManager: 'wua',
        pendingTotal: toInt(probe.data.pending) ?? 0,
        pendingSecurity: toInt(probe.data.security) ?? 0,
        oldestPendingSecurityDays: oldest ? wholeDaysBetween(oldest, now) : null,
        // The search above just succeeded against the configured update source
        lastScanAt: now,
        lastInstalledAt: parseDate(probe.data.last_install),
        rebootPending: Boolean(probe.data.reboot),
        sampleTitles: titles.map(String),
      },
    };
  }

  private async scanMac(context: EvidenceContext): Promise<PatchScanResult> {
    const list = await context.runner.run('softwareupdate', ['--list'], { timeoutMs: 180000 });
    if (!list.ok) return { ok: false, source: 'cli:softwareupdate', failure: list };

    // "No new software available." goes to stderr; listed updates look like "* Label: ..." + a Title line
    const lines = `${list.stdout}\n${list.stderr}`.split(/\r?\n/).map((line) => line.trim());
    const labels = lines.filter((line) => line.startsWith('* Label:')).map((line) => line.replace('* Label:', '').trim());
    const recommended = lines.filter((line) => /^Title:/.test(line) && /Recommended:\s*YES/i.test(line)).length;

    const history = await context.runner.run('softwareupdate', ['--history'], { timeoutMs: 60000 });
    return {
      ok: true,
      scan: {
        packageManager: 'softwareupdate',
        pendingTotal: labels.length,
        // Apple ships security fixes in its recommended updates and does not label them separately
        pendingSecurity: recommended,
        oldestPendingSecurityDays: null,
        lastScanAt: context.now(),
        lastInstalledAt: history.ok ? latestMacHistoryDate(history.stdout) : null,
        rebootPending: null,
        sampleTitles: labels.slice(0, 20),
      },
    };
  }

  private async scanLinux(context: EvidenceContext): Promise<PatchScanResult> {
    const apt = await this.scanApt(context);
    if (apt) return apt;
    for (const bin of ['dnf', 'yum'] as const) {
      const rpm = await this.scanDnf(context, bin);
      if (rpm) return rpm;
    }
    const zypper = await this.scanZypper(context);
    if (zypper) return zypper;

    return {
      ok: false,
      source: 'cli:apt-get,dnf,yum,zypper',
      failure: { ok: false, reason: 'tool_unavailable', exitCode: null, stdout: '', stderr: '', error: 'no supported package manager found' },
    };
  }

  /** Returns null when apt is not installed, so the next package manager is tried. */
  private async scanApt(context: EvidenceContext): Promise<PatchScanResult | null> {
    const result = await context.runner.run('apt-get', ['-s', '-o', 'Debug::NoLocking=1', 'upgrade'], { timeoutMs: 120000 });
    if (!result.ok && result.reason === 'tool_unavailable') return null;
    if (!result.ok) return { ok: false, source: 'cli:apt-get', failure: result };

    const inst = result.stdout.split(/\r?\n/).filter((line) => line.startsWith('Inst '));
    const security = inst.filter((line) => /-security\b/i.test(line));
    const lastScanAt =
      (await context.files.modifiedAt('/var/lib/apt/periodic/update-success-stamp')) ??
      (await context.files.modifiedAt('/var/lib/apt/lists'));
    const history = await context.files.readText('/var/log/apt/history.log', 256 * 1024);

    return {
      ok: true,
      scan: {
        packageManager: 'apt',
        pendingTotal: inst.length,
        pendingSecurity: security.length,
        oldestPendingSecurityDays: null,
        lastScanAt,
        lastInstalledAt: history ? latestAptHistoryDate(history) : null,
        rebootPending: await context.files.exists('/var/run/reboot-required'),
        sampleTitles: inst.slice(0, 20).map((line) => line.split(' ')[1] || line),
      },
    };
  }

  private async scanDnf(context: EvidenceContext, bin: 'dnf' | 'yum'): Promise<PatchScanResult | null> {
    // check-update exits 100 when updates are available
    const check = await runAccepting(context, bin, ['-q', 'check-update'], [100], 180000);
    if (!check.ok && check.reason === 'tool_unavailable') return null;
    if (!check.ok) return { ok: false, source: `cli:${bin}`, failure: check };

    const packages = parseRpmUpdateList(check.stdout);
    const advisories = await context.runner.run(bin, ['-q', 'updateinfo', 'list', '--security'], { timeoutMs: 120000 });
    const securityPackages = advisories.ok
      ? new Set(advisories.stdout.split(/\r?\n/).map((line) => line.trim().split(/\s+/)[2]).filter(Boolean)).size
      : 0;

    return {
      ok: true,
      scan: {
        packageManager: bin,
        pendingTotal: packages.length,
        pendingSecurity: securityPackages,
        oldestPendingSecurityDays: null,
        lastScanAt: context.now(),
        lastInstalledAt: await latestRpmInstall(context),
        rebootPending: await rpmRebootPending(context, ['needs-restarting', ['-r']], [1]),
        sampleTitles: packages.slice(0, 20),
      },
    };
  }

  private async scanZypper(context: EvidenceContext): Promise<PatchScanResult | null> {
    // zypper exits 100+ when updates/patches are available
    const list = await runAccepting(context, 'zypper', ['--non-interactive', '--quiet', 'list-updates'], [100, 101, 102, 103], 180000);
    if (!list.ok && list.reason === 'tool_unavailable') return null;
    if (!list.ok) return { ok: false, source: 'cli:zypper', failure: list };

    const rows = list.stdout.split(/\r?\n/).filter((line) => /^v\s*\|/.test(line.trim()));
    const patches = await runAccepting(context, 'zypper', ['--non-interactive', '--quiet', 'list-patches', '--category', 'security'], [100, 101, 102, 103], 120000);
    const security = patches.ok ? patches.stdout.split(/\r?\n/).filter((line) => /\|\s*security\s*\|/i.test(line)).length : 0;

    return {
      ok: true,
      scan: {
        packageManager: 'zypper',
        pendingTotal: rows.length,
        pendingSecurity: security,
        oldestPendingSecurityDays: null,
        lastScanAt: context.now(),
        lastInstalledAt: await latestRpmInstall(context),
        rebootPending: await rpmRebootPending(context, ['zypper', ['needs-rebooting']], [102]),
        sampleTitles: rows.slice(0, 20).map((row) => row.split('|')[2]?.trim() || row),
      },
    };
  }
}

/** Package names from `dnf/yum check-update` ("name.arch  version  repo" rows, before any "Obsoleting" section). */
export function parseRpmUpdateList(stdout: string): string[] {
  const packages: string[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (/^Obsoleting/i.test(line)) break;
    const columns = line.split(/\s+/);
    if (columns.length === 3 && /\.[\w]+$/.test(columns[0])) packages.push(columns[0]);
  }
  return packages;
}

/** Latest "End-Date: 2026-10-15  02:11:05" in apt's history log (local time). */
export function latestAptHistoryDate(history: string): Date | null {
  let latest: Date | null = null;
  for (const match of history.matchAll(/^End-Date:\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/gm)) {
    const date = new Date(`${match[1]}T${match[2]}`);
    if (!Number.isNaN(date.getTime()) && (!latest || date > latest)) latest = date;
  }
  return latest;
}

/** Latest install date in `softwareupdate --history` ("Name  Version  MM/DD/YYYY, HH:MM:SS"). */
export function latestMacHistoryDate(history: string): Date | null {
  let latest: Date | null = null;
  for (const match of history.matchAll(/(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{2}:\d{2}:\d{2})/g)) {
    const date = new Date(`${match[3]}-${match[1]}-${match[2]}T${match[4]}`);
    if (!Number.isNaN(date.getTime()) && (!latest || date > latest)) latest = date;
  }
  return latest;
}

async function latestRpmInstall(context: EvidenceContext): Promise<Date | null> {
  const result = await context.runner.run('rpm', ['-qa', '--qf', '%{INSTALLTIME}\\n'], { timeoutMs: 60000 });
  if (!result.ok) return null;
  const newest = Math.max(0, ...result.stdout.split(/\r?\n/).map((line) => Number(line.trim())).filter(Number.isFinite));
  return newest > 0 ? new Date(newest * 1000) : null;
}

/** Runs a "reboot needed?" tool whose listed exit codes mean yes and 0 means no; null when it is not available. */
async function rpmRebootPending(context: EvidenceContext, [file, args]: [string, string[]], yesCodes: number[]): Promise<boolean | null> {
  const result = await context.runner.run(file, args, { timeoutMs: 60000 });
  if (result.ok) return false;
  if (result.reason === 'command_failed' && result.exitCode !== null && yesCodes.includes(result.exitCode)) return true;
  return null;
}
