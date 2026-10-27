import { EvidenceContext, EvidencePack } from '../evidencePack';
import { failed, fromFailure, ok, unknown } from '../evidenceItem';
import { runAccepting, runPowerShellJson, toBool } from '../probes';
import { EvidenceItem, ExposureItems, FirewallValue, ListeningPort, RemoteAccessValue } from '../../types/evidence';

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$fw = $null
try {
  $fw = @(Get-NetFirewallProfile -PolicyStore ActiveStore | ForEach-Object {
    [pscustomobject]@{ name = ([string]$_.Name).ToLower(); enabled = ([string]$_.Enabled -eq 'True') }
  })
} catch {}
$ts = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server' -ErrorAction SilentlyContinue
$rdp = Get-ItemProperty 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp' -ErrorAction SilentlyContinue
$sshd = Get-Service -Name sshd -ErrorAction SilentlyContinue
[pscustomobject]@{
  firewall = $fw
  rdp_enabled = $(if ($ts -ne $null -and $ts.fDenyTSConnections -ne $null) { $ts.fDenyTSConnections -eq 0 } else { $null })
  rdp_nla = $(if ($rdp -ne $null -and $rdp.UserAuthentication -ne $null) { $rdp.UserAuthentication -eq 1 } else { $null })
  ssh_server = $(if ($sshd) { [string]$sshd.Status -eq 'Running' } else { $false })
} | ConvertTo-Json -Compress -Depth 4
`.trim();

interface WindowsExposureJson {
  firewall: Array<{ name: string; enabled: boolean }> | { name: string; enabled: boolean } | null;
  rdp_enabled: boolean | null;
  rdp_nla: boolean | null;
  ssh_server: boolean | null;
}

type ProfileName = FirewallValue['profiles'][number]['name'];

/** Parses `nft list ruleset`: an input-hook chain with a drop policy or any rule counts as an active firewall. */
export function nftablesActive(ruleset: string): boolean {
  const chains = ruleset.split(/\bchain\s+/).slice(1);
  return chains.some((chain) => /hook\s+input/.test(chain) && (/policy\s+drop/.test(chain) || chain.split(/\r?\n/).filter((line) => /^\s+(ip|tcp|udp|ct|iif|meta|counter|accept|drop|reject|jump)\b/.test(line)).length > 0));
}

/** Parses `iptables -S INPUT`: a DROP policy or any appended rule counts as an active firewall. */
export function iptablesActive(rules: string): boolean {
  return /^-P INPUT (DROP|REJECT)/m.test(rules) || /^-A INPUT /m.test(rules);
}

export function bindScope(address: string): ListeningPort['bind_scope'] {
  if (address === '0.0.0.0' || address === '::' || address === '*' || address === '') return 'any';
  if (address.startsWith('127.') || address === '::1') return 'loopback';
  return 'specific';
}

/** Network Exposure & Remote Access: host firewall, remote access services and listening ports. */
export class ExposurePack implements EvidencePack<'exposure'> {
  readonly category = 'exposure' as const;

  async collect(context: EvidenceContext): Promise<ExposureItems> {
    const listening_ports = await this.listeningPorts(context);
    switch (context.platform) {
      case 'windows':
        return { ...(await this.windows(context)), listening_ports };
      case 'macos':
        return { firewall: await this.macFirewall(context), remote_access: await this.macRemoteAccess(context), listening_ports };
      case 'linux':
        return { firewall: await this.linuxFirewall(context), remote_access: await this.linuxRemoteAccess(context), listening_ports };
    }
  }

  private async windows(context: EvidenceContext): Promise<Pick<ExposureItems, 'firewall' | 'remote_access'>> {
    const source = 'powershell:Get-NetFirewallProfile,registry,Get-Service';
    const probe = await runPowerShellJson<WindowsExposureJson>(context, WINDOWS_SCRIPT);
    if (!probe.ok) {
      const failure = fromFailure<never>(source, probe, context.elevated);
      return { firewall: failure, remote_access: failure };
    }

    const profiles = probe.data.firewall === null ? null : Array.isArray(probe.data.firewall) ? probe.data.firewall : [probe.data.firewall];
    const firewall: EvidenceItem<FirewallValue> = profiles
      ? ok('powershell:Get-NetFirewallProfile', {
          product: 'windows_firewall',
          profiles: profiles
            .filter((profile) => ['domain', 'private', 'public'].includes(profile.name))
            .map((profile) => ({ name: profile.name as ProfileName, enabled: Boolean(profile.enabled) })),
        })
      : failed('powershell:Get-NetFirewallProfile', 'command_failed', 'Get-NetFirewallProfile returned nothing');

    return {
      firewall,
      remote_access: ok('registry:TerminalServer;service:sshd', {
        rdp_enabled: probe.data.rdp_enabled,
        rdp_nla_required: probe.data.rdp_nla,
        ssh_server_enabled: probe.data.ssh_server,
        screen_sharing_enabled: null,
      }),
    };
  }

  private async macFirewall(context: EvidenceContext): Promise<EvidenceItem<FirewallValue>> {
    const result = await context.runner.run('/usr/libexec/ApplicationFirewall/socketfilterfw', ['--getglobalstate'], { timeoutMs: 15000 });
    if (result.ok && /firewall is (enabled|disabled|blocking)/i.test(result.stdout)) {
      // "Firewall is enabled. (State = 1)", "Firewall is blocking all non-essential connections (State = 2)"
      const enabled = !/firewall is disabled/i.test(result.stdout);
      return ok('cli:socketfilterfw', { product: 'macos_alf', profiles: [{ name: 'global', enabled }] });
    }

    const alf = await context.osquery.query<{ global_state: string }>('SELECT global_state FROM alf');
    if (alf.ok && alf.rows.length) {
      return ok('osquery:alf', { product: 'macos_alf', profiles: [{ name: 'global', enabled: Number(alf.rows[0].global_state) > 0 }] });
    }
    return result.ok ? failed('cli:socketfilterfw', 'parse_error', 'unrecognised socketfilterfw output') : fromFailure('cli:socketfilterfw', result, context.elevated);
  }

  private async macRemoteAccess(context: EvidenceContext): Promise<EvidenceItem<RemoteAccessValue>> {
    const sharing = await context.osquery.query<{ screen_sharing: string; remote_login: string; remote_management: string }>(
      'SELECT screen_sharing, remote_login, remote_management FROM sharing_preferences',
    );
    if (sharing.ok && sharing.rows.length) {
      const row = sharing.rows[0];
      return ok('osquery:sharing_preferences', {
        rdp_enabled: null,
        rdp_nla_required: null,
        ssh_server_enabled: toBool(row.remote_login),
        screen_sharing_enabled: Boolean(toBool(row.screen_sharing) || toBool(row.remote_management)),
      });
    }

    const remoteLogin = await context.runner.run('systemsetup', ['-getremotelogin'], { timeoutMs: 15000 });
    if (!remoteLogin.ok) return fromFailure('cli:systemsetup', remoteLogin, context.elevated);
    return ok('cli:systemsetup', {
      rdp_enabled: null,
      rdp_nla_required: null,
      ssh_server_enabled: /remote login:\s*on/i.test(remoteLogin.stdout),
      screen_sharing_enabled: null,
    });
  }

  private async linuxFirewall(context: EvidenceContext): Promise<EvidenceItem<FirewallValue>> {
    const global = (product: FirewallValue['product'], enabled: boolean, source: string) =>
      ok<FirewallValue>(source, { product, profiles: [{ name: 'global', enabled }] });
    let lastFailure: Parameters<typeof fromFailure>[1] | null = null;

    const ufw = await context.runner.run('ufw', ['status'], { timeoutMs: 15000 });
    if (ufw.ok) return global('ufw', /status:\s*active/i.test(ufw.stdout), 'cli:ufw');
    if (ufw.reason !== 'tool_unavailable') lastFailure = ufw;

    // firewall-cmd --state exits 252 when firewalld is installed but not running
    const firewalld = await runAccepting(context, 'firewall-cmd', ['--state'], [252], 15000);
    if (firewalld.ok) return global('firewalld', /^running/m.test(firewalld.stdout.trim()), 'cli:firewall-cmd');
    if (firewalld.reason !== 'tool_unavailable') lastFailure = firewalld;

    const nft = await context.runner.run('nft', ['list', 'ruleset'], { timeoutMs: 15000 });
    if (nft.ok && nftablesActive(nft.stdout)) return global('nftables', true, 'cli:nft');
    if (!nft.ok && nft.reason !== 'tool_unavailable') lastFailure = nft;

    const iptables = await context.runner.run('iptables', ['-S', 'INPUT'], { timeoutMs: 15000 });
    if (iptables.ok && iptablesActive(iptables.stdout)) return global('iptables', true, 'cli:iptables');
    if (!iptables.ok && iptables.reason !== 'tool_unavailable') lastFailure = iptables;

    if (nft.ok || iptables.ok) return ok('cli:nft,iptables', { product: 'none', profiles: [{ name: 'global', enabled: false }] });
    // Tools exist but could not be read (typically not root): we cannot tell
    if (lastFailure) return fromFailure('cli:ufw,firewall-cmd,nft,iptables', lastFailure, context.elevated);
    return ok('cli:ufw,firewall-cmd,nft,iptables', { product: 'none', profiles: [{ name: 'global', enabled: false }] });
  }

  private async linuxRemoteAccess(context: EvidenceContext): Promise<EvidenceItem<RemoteAccessValue>> {
    const active = async (unit: string): Promise<boolean | null> => {
      // is-active exits 3 for inactive units and 4 for unknown ones
      const result = await runAccepting(context, 'systemctl', ['is-active', unit], [3, 4], 10000);
      return result.ok ? result.stdout.trim() === 'active' : null;
    };
    const [ssh, sshd, xrdp] = await Promise.all([active('ssh'), active('sshd'), active('xrdp')]);
    if (ssh === null && sshd === null) return unknown('cli:systemctl', 'tool_unavailable', 'systemctl not available');
    return ok('cli:systemctl', {
      rdp_enabled: xrdp,
      rdp_nla_required: null,
      ssh_server_enabled: Boolean(ssh || sshd),
      screen_sharing_enabled: null,
    });
  }

  private async listeningPorts(context: EvidenceContext): Promise<EvidenceItem<{ ports: ListeningPort[] }>> {
    const source = 'osquery:listening_ports,processes';
    if (!context.osquery.available()) return unknown(source, 'tool_unavailable', 'osquery binary not bundled');
    const query = await context.osquery.query<{ protocol: string; port: string; address: string; name: string | null }>(
      'SELECT DISTINCT lp.protocol, lp.port, lp.address, p.name FROM listening_ports lp LEFT JOIN processes p USING (pid) WHERE lp.port > 0 AND lp.family IN (2, 10)',
    );
    if (!query.ok) return fromFailure(source, query, context.elevated);

    const seen = new Set<string>();
    const ports: ListeningPort[] = [];
    for (const row of query.rows) {
      const protocol = Number(row.protocol) === 17 ? 'udp' : Number(row.protocol) === 6 ? 'tcp' : null;
      const port = Number(row.port);
      if (!protocol || !Number.isInteger(port) || port < 1 || port > 65535) continue;
      const entry: ListeningPort = { protocol, port, bind_scope: bindScope(String(row.address ?? '')), process_name: row.name ? String(row.name).slice(0, 255) : null };
      const key = `${entry.protocol}/${entry.port}/${entry.bind_scope}/${entry.process_name}`;
      if (!seen.has(key) && ports.length < 500) {
        seen.add(key);
        ports.push(entry);
      }
    }
    return ok(source, { ports });
  }
}

