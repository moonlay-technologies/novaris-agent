import { EvidenceContext, EvidencePack } from '../evidencePack';
import { fromFailure, ok, unknown } from '../evidenceItem';
import { runAccepting, runPowerShellJson, toInt } from '../probes';
import { AccessItems, AdminMember, DefaultAccountsValue, EvidenceItem, LocalAdminsValue, ScreenLockValue } from '../../types/evidence';

const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
$members = @()
try {
  $members = @(Get-LocalGroupMember -SID 'S-1-5-32-544' | ForEach-Object {
    [pscustomobject]@{ name = [string]$_.Name; class = [string]$_.ObjectClass; source = [string]$_.PrincipalSource }
  })
} catch {
  # Get-LocalGroupMember fails on orphaned or Entra ID members; ADSI still lists them
  $group = (New-Object System.Security.Principal.SecurityIdentifier('S-1-5-32-544')).Translate([System.Security.Principal.NTAccount]).Value.Split('\\')[-1]
  $adsi = [ADSI]"WinNT://$env:COMPUTERNAME/$group,group"
  $members = @($adsi.Invoke('Members') | ForEach-Object {
    $path = $_.GetType().InvokeMember('ADsPath', 'GetProperty', $null, $_, $null)
    $class = $_.GetType().InvokeMember('Class', 'GetProperty', $null, $_, $null)
    $parts = ($path -replace '^WinNT://', '') -split '/'
    $owner = $parts[$parts.Length - 2]
    [pscustomobject]@{ name = "$owner\\$($parts[$parts.Length - 1])"; class = [string]$class; source = $(if ($owner -ieq $env:COMPUTERNAME) { 'Local' } else { 'ActiveDirectory' }) }
  })
}
$local = @{}
$guest = $null
$builtinAdmin = $null
try {
  foreach ($u in Get-LocalUser) {
    $local[("$env:COMPUTERNAME\\" + $u.Name).ToLower()] = [bool]$u.Enabled
    if ($u.SID.Value -like '*-501') { $guest = [bool]$u.Enabled }
    if ($u.SID.Value -like '*-500') { $builtinAdmin = [bool]$u.Enabled }
  }
} catch {}
$inactivity = (Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System' -ErrorAction SilentlyContinue).InactivityTimeoutSecs
$policies = @()
$settings = @()
foreach ($hive in Get-ChildItem 'Registry::HKEY_USERS' -ErrorAction SilentlyContinue) {
  $sid = $hive.PSChildName
  if (($sid -notmatch '^S-1-(5-21|12-1)-') -or ($sid -like '*_Classes')) { continue }
  $p = Get-ItemProperty "Registry::HKEY_USERS\\$sid\\Software\\Policies\\Microsoft\\Windows\\Control Panel\\Desktop" -ErrorAction SilentlyContinue
  if ($p -and $p.ScreenSaveActive -ne $null) { $policies += [pscustomobject]@{ active = [string]$p.ScreenSaveActive; secure = [string]$p.ScreenSaverIsSecure; timeout = [string]$p.ScreenSaveTimeOut } }
  $d = Get-ItemProperty "Registry::HKEY_USERS\\$sid\\Control Panel\\Desktop" -ErrorAction SilentlyContinue
  if ($d) { $settings += [pscustomobject]@{ active = [string]$d.ScreenSaveActive; secure = [string]$d.ScreenSaverIsSecure; timeout = [string]$d.ScreenSaveTimeOut } }
}
[pscustomobject]@{
  members = $members
  enabled = $local
  guest = $guest
  builtin_admin = $builtinAdmin
  inactivity = $inactivity
  policies = $policies
  settings = $settings
} | ConvertTo-Json -Compress -Depth 4
`.trim();

type ScreenSaverEntry = { active: string; secure: string; timeout: string };

interface WindowsAccessJson {
  members: Array<{ name: string; class: string; source: string }> | { name: string; class: string; source: string } | null;
  enabled: Record<string, boolean> | null;
  guest: boolean | null;
  builtin_admin: boolean | null;
  inactivity: number | null;
  policies: ScreenSaverEntry[] | ScreenSaverEntry | null;
  settings: ScreenSaverEntry[] | ScreenSaverEntry | null;
}

const asArray = <T>(value: T[] | T | null | undefined): T[] => (value === null || value === undefined ? [] : Array.isArray(value) ? value : [value]);

/**
 * Least strict of several screen saver configurations (several users may be
 * signed in): a disabled or unsecured screen saver wins, then the longest timeout.
 */
export function weakestScreenSaver(entries: ScreenSaverEntry[], scope: ScreenLockValue['scope']): ScreenLockValue | null {
  if (!entries.length) return null;
  const parsed = entries.map((entry) => ({
    enabled: entry.active === '1',
    secure: entry.secure === '1',
    timeout: toInt(entry.timeout),
  }));
  const disabled = parsed.find((entry) => !entry.enabled);
  if (disabled) return { enabled: false, timeout_seconds: null, password_on_wake: disabled.secure, scope };
  const longest = parsed.reduce((worst, entry) => ((entry.timeout ?? Infinity) > (worst.timeout ?? Infinity) ? entry : worst));
  return {
    enabled: true,
    timeout_seconds: longest.timeout,
    password_on_wake: parsed.every((entry) => entry.secure),
    scope,
  };
}

/** Reads GNOME lock settings from system dconf databases (/etc/dconf/db/*.d/*). */
export function parseDconfLock(files: string[]): ScreenLockValue | null {
  let idle: number | null = null;
  let lockEnabled: boolean | null = null;
  for (const content of files) {
    let section = '';
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      const header = line.match(/^\[(.+)\]$/);
      if (header) {
        section = header[1];
        continue;
      }
      const [key, value] = line.split('=').map((part) => part?.trim());
      if (section === 'org/gnome/desktop/session' && key === 'idle-delay') idle = toInt(String(value).replace(/^uint32\s+/, ''));
      if (section === 'org/gnome/desktop/screensaver' && key === 'lock-enabled') lockEnabled = value === 'true';
    }
  }
  if (idle === null && lockEnabled === null) return null;
  // GNOME: idle-delay 0 means the screen never blanks, so it never locks
  const enabled = lockEnabled !== false && idle !== 0;
  return { enabled, timeout_seconds: enabled ? idle : null, password_on_wake: lockEnabled, scope: 'machine_policy' };
}

/** Identity, Access & Session: local administrators, default accounts and screen lock. */
export class AccessPack implements EvidencePack<'access'> {
  readonly category = 'access' as const;

  async collect(context: EvidenceContext): Promise<AccessItems> {
    switch (context.platform) {
      case 'windows':
        return this.windows(context);
      case 'macos':
        return this.mac(context);
      case 'linux':
        return this.linux(context);
    }
  }

  private async windows(context: EvidenceContext): Promise<AccessItems> {
    const source = 'powershell:Get-LocalGroupMember,Get-LocalUser,registry';
    const probe = await runPowerShellJson<WindowsAccessJson>(context, WINDOWS_SCRIPT);
    if (!probe.ok) {
      const failure = fromFailure<never>(source, probe, context.elevated);
      return { local_admins: failure, screen_lock: failure, default_accounts: failure };
    }

    const enabled = probe.data.enabled ?? {};
    const members: AdminMember[] = asArray(probe.data.members).map((member) => ({
      name: String(member.name).slice(0, 255),
      type: /group/i.test(member.class) ? 'group' : /user/i.test(member.class) ? 'user' : 'unknown',
      scope: /local/i.test(member.source) ? 'local' : /activedirectory|azuread|microsoftaccount/i.test(member.source) ? 'domain' : 'unknown',
      enabled: enabled[String(member.name).toLowerCase()] ?? null,
    }));

    const inactivity = toInt(probe.data.inactivity);
    const screenLock: ScreenLockValue =
      inactivity && inactivity > 0
        ? { enabled: true, timeout_seconds: inactivity, password_on_wake: true, scope: 'machine_policy' }
        : weakestScreenSaver(asArray(probe.data.policies), 'machine_policy') ??
          weakestScreenSaver(asArray(probe.data.settings), 'console_user') ?? { enabled: false, timeout_seconds: null, password_on_wake: null, scope: 'machine_policy' };

    return {
      local_admins: ok('powershell:Get-LocalGroupMember', { members, count: members.length }),
      screen_lock: ok('registry:InactivityTimeoutSecs,ScreenSaver', screenLock),
      default_accounts: ok('powershell:Get-LocalUser', { guest_enabled: probe.data.guest, builtin_admin_enabled: probe.data.builtin_admin }),
    };
  }

  private async mac(context: EvidenceContext): Promise<AccessItems> {
    const admins = await context.runner.run('dscl', ['.', '-read', '/Groups/admin', 'GroupMembership'], { timeoutMs: 15000 });
    const localAdmins: EvidenceItem<LocalAdminsValue> = admins.ok
      ? (() => {
          // root is the system account, present on every Mac; it is not an operator choice
          const names = admins.stdout.replace(/^GroupMembership:/m, '').trim().split(/\s+/).filter((name) => name && name !== 'root');
          const members: AdminMember[] = names.map((name) => ({ name, type: 'user', scope: 'local', enabled: null }));
          return ok('cli:dscl', { members, count: members.length });
        })()
      : fromFailure('cli:dscl', admins, context.elevated);

    // The key is absent when Guest was never enabled; `defaults read` then exits 1
    const guest = await runAccepting(context, 'defaults', ['read', '/Library/Preferences/com.apple.loginwindow', 'GuestEnabled'], [1], 10000);
    const defaultAccounts: EvidenceItem<DefaultAccountsValue> = guest.ok
      ? ok('cli:defaults:loginwindow', { guest_enabled: guest.stdout.trim() === '1', builtin_admin_enabled: null })
      : fromFailure('cli:defaults:loginwindow', guest, context.elevated);

    return { local_admins: localAdmins, screen_lock: await this.macScreenLock(context), default_accounts: defaultAccounts };
  }

  private async macScreenLock(context: EvidenceContext): Promise<EvidenceItem<ScreenLockValue>> {
    // An MDM profile wins over user settings
    const managed = await context.runner.run('defaults', ['read', '/Library/Managed Preferences/com.apple.screensaver', 'idleTime'], { timeoutMs: 10000 });
    if (managed.ok && toInt(managed.stdout.trim()) !== null) {
      const idle = toInt(managed.stdout.trim()) as number;
      const ask = await context.runner.run('defaults', ['read', '/Library/Managed Preferences/com.apple.screensaver', 'askForPassword'], { timeoutMs: 10000 });
      return ok('plist:managed com.apple.screensaver', {
        enabled: idle > 0,
        timeout_seconds: idle > 0 ? idle : null,
        password_on_wake: ask.ok ? ask.stdout.trim() === '1' : null,
        scope: 'machine_policy',
      });
    }

    const owner = await context.runner.run('stat', ['-f', '%Su', '/dev/console'], { timeoutMs: 5000 });
    const user = owner.ok ? owner.stdout.trim() : '';
    if (!user || user === 'root' || user === 'loginwindow') {
      return unknown('cli:stat:/dev/console', 'not_detected', 'no user signed in and no managed screen saver policy');
    }

    const asUser = (args: string[]) =>
      context.elevated
        ? context.runner.run('sudo', ['-n', '-u', user, ...args], { timeoutMs: 10000 })
        : context.runner.run(args[0], args.slice(1), { timeoutMs: 10000 });
    const idle = await asUser(['defaults', '-currentHost', 'read', 'com.apple.screensaver', 'idleTime']);
    // macOS defaults to a 20-minute screen saver when the user never changed it
    const idleSeconds = idle.ok ? toInt(idle.stdout.trim()) : 1200;
    const lock = await asUser(['sysadminctl', '-screenLock', 'status']);
    const lockText = lock.ok ? `${lock.stdout}${lock.stderr}` : '';
    const passwordOnWake = /screenLock is off/i.test(lockText) ? false : /screenLock delay is/i.test(lockText) ? true : null;

    return ok('cli:defaults,sysadminctl (console user)', {
      enabled: (idleSeconds ?? 0) > 0 && passwordOnWake !== false,
      timeout_seconds: idleSeconds && idleSeconds > 0 ? idleSeconds : null,
      password_on_wake: passwordOnWake,
      scope: 'console_user',
    });
  }

  private async linux(context: EvidenceContext): Promise<AccessItems> {
    // getent exits 2 when some of the requested groups do not exist, still printing the others
    const groups = await runAccepting(context, 'getent', ['group', 'sudo', 'wheel', 'admin'], [2], 10000);
    const localAdmins: EvidenceItem<LocalAdminsValue> = groups.ok
      ? (() => {
          const names = new Set<string>();
          for (const line of groups.stdout.split(/\r?\n/)) {
            const users = line.split(':')[3];
            users?.split(',').map((name) => name.trim()).filter(Boolean).forEach((name) => names.add(name));
          }
          const members: AdminMember[] = Array.from(names).map((name) => ({ name, type: 'user', scope: 'unknown', enabled: null }));
          return ok('cli:getent group', { members, count: members.length });
        })()
      : fromFailure('cli:getent', groups, context.elevated);

    // Never read /etc/shadow: account existence is enough to flag a guest account
    const guest = await runAccepting(context, 'getent', ['passwd', 'guest'], [2], 10000);
    const defaultAccounts: EvidenceItem<DefaultAccountsValue> = guest.ok
      ? ok('cli:getent passwd', { guest_enabled: guest.stdout.trim() ? null : false, builtin_admin_enabled: null })
      : fromFailure('cli:getent', guest, context.elevated);

    return { local_admins: localAdmins, screen_lock: await this.linuxScreenLock(context), default_accounts: defaultAccounts };
  }

  private async linuxScreenLock(context: EvidenceContext): Promise<EvidenceItem<ScreenLockValue>> {
    const source = 'file:/etc/dconf/db';
    const contents: string[] = [];
    for (const dir of await context.files.list('/etc/dconf/db')) {
      if (!dir.endsWith('.d')) continue;
      for (const file of await context.files.list(dir)) {
        const text = await context.files.readText(file, 64 * 1024);
        if (text) contents.push(text);
      }
    }
    const value = parseDconfLock(contents);
    return value ? ok(source, value) : unknown(source, 'not_detected', 'no system-wide screen lock policy found (desktop settings are per user)');
  }
}
