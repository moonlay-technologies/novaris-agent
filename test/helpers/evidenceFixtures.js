// Recorded OS outputs per platform and the envelopes the agent builds from them.
// Shared by the unit tests and by schema validation against the backend contract.
const path = require('path');
const { FakeRunner, FakeOsquery, FakeFiles, context } = require('./evidenceFakes');

const dist = (p) => require(path.join(__dirname, '..', '..', 'dist', p));

const IDENTITY = {
  windows: {
    osInfo: async () => ({ distro: 'Microsoft Windows 11 Pro', release: '10.0.26200', build: '26200', arch: 'x64', hostname: 'LAPTOP-0001' }),
    system: async () => ({ manufacturer: 'LENOVO', model: '20XW', serial: 'PF3ABC12' }),
    defaultInterface: async () => ({ ip4: '10.0.4.21', mac: '00:11:22:33:44:55' }),
    hostname: () => 'LAPTOP-0001',
  },
  macos: {
    osInfo: async () => ({ distro: 'macOS', release: '14.6.1', build: '23G93', arch: 'arm64', hostname: 'MBP-0002' }),
    system: async () => ({ manufacturer: 'Apple Inc.', model: 'Mac15,6', serial: 'C02XYZ123' }),
    defaultInterface: async () => ({ ip4: '10.0.4.22', mac: 'aa:bb:cc:dd:ee:ff' }),
    hostname: () => 'MBP-0002',
  },
  linux: {
    osInfo: async () => ({ distro: 'Ubuntu', release: '24.04.1 LTS', build: '', arch: 'x64', hostname: 'ws-0003' }),
    system: async () => ({ manufacturer: 'Dell Inc.', model: 'Latitude 5440', serial: '' }),
    defaultInterface: async () => ({ ip4: '10.0.4.23', mac: '11:22:33:44:55:66' }),
    hostname: () => 'ws-0003',
  },
};

/** PowerShell answers, selected by a marker that appears in each script. */
const WINDOWS_POWERSHELL = {
  'Microsoft.Update.Session': {
    pending: 2, security: 1, oldest: '2026-10-18T00:00:00.0000000Z', last_install: '2026-10-15T02:11:00.0000000Z', reboot: false,
    titles: ['2026-10 Cumulative Update for Windows 11 (KB5099999)', 'Microsoft Defender Antivirus antimalware platform update'],
  },
  'Get-MpComputerStatus': {
    defender: { realtime: true, signature_age: 0, tamper: true, mode: 'Normal' },
    products: { displayName: 'Windows Defender', productState: 397568 },
  },
  'Get-NetFirewallProfile': {
    firewall: [{ name: 'domain', enabled: true }, { name: 'private', enabled: true }, { name: 'public', enabled: true }],
    rdp_enabled: false, rdp_nla: true, ssh_server: false,
  },
  'S-1-5-32-544': {
    members: [
      { name: 'LAPTOP-0001\\Administrator', class: 'User', source: 'Local' },
      { name: 'CORP\\IT-Admins', class: 'Group', source: 'ActiveDirectory' },
    ],
    enabled: { 'laptop-0001\\administrator': false },
    guest: false, builtin_admin: false, inactivity: 600, policies: [], settings: [],
  },
  'Confirm-SecureBootUEFI': { supported: true, enabled: true, error: null },
  'Get-Tpm': { present: true, ready: true, version: '2.0' },
  'Get-SmbServerConfiguration': { smb1: false, autorun: 255, llmnr: 0, uac: 1 },
};

function windowsPowerShell(answers) {
  return (args) => {
    const script = args[args.length - 1];
    const marker = Object.keys(answers).find((key) => script.includes(key));
    return marker ? { ok: true, stdout: JSON.stringify(answers[marker]), stderr: '' } : undefined;
  };
}

const AUDITPOL_CSV = [
  'Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting',
  'LAPTOP-0001,System,Logon,{0CCE9215-69AE-11D9-BED3-505054503030},Success and Failure,',
  'LAPTOP-0001,System,Account Lockout,{0CCE9217-69AE-11D9-BED3-505054503030},Failure,',
  'LAPTOP-0001,System,User Account Management,{0CCE9235-69AE-11D9-BED3-505054503030},Success,',
  'LAPTOP-0001,System,Filtering Platform Packet Drop,{0CCE9225-69AE-11D9-BED3-505054503030},No Auditing,',
].join('\r\n');

/** Command outputs per platform, keyed like FakeRunner expects. */
const COMMANDS = {
  windows: {
    'dsregcmd /status': 'AzureAdJoined : YES\nDomainJoined : NO\nMdmUrl : https://enrollment.manage.microsoft.com/x\n',
    powershell: windowsPowerShell(WINDOWS_POWERSHELL),
    'sc query eventlog': 'SERVICE_NAME: eventlog\n        STATE              : 4  RUNNING\n',
    'sc query w32time': 'SERVICE_NAME: w32time\n        STATE              : 4  RUNNING\n',
    'auditpol /get /category:* /r': AUDITPOL_CSV,
    'wevtutil gl Security': 'name: Security\nenabled: true\nlogging:\n  maxSize: 20971520\n',
  },
  macos: {
    'profiles status -type enrollment': 'MDM enrollment: Yes (User Approved)\n',
    'dsconfigad -show': '',
    'softwareupdate --list': 'Software Update Tool\n\nFinding available software\nSoftware Update found the following new or updated software:\n* Label: macOS Sonoma 14.7-23H124\n\tTitle: macOS Sonoma 14.7, Version: 14.7, Size: 1234K, Recommended: YES, Action: restart,\n',
    'softwareupdate --history': 'Display Name                                       Version    Date\n------------                                       -------    ----\nmacOS Sonoma 14.6.1                                14.6.1     08/07/2024, 10:21:15\n',
    'spctl --status': 'assessments enabled\n',
    'fdesetup status': 'FileVault is On.\n',
    'dscl . -read /Groups/admin GroupMembership': 'GroupMembership: root alice\n',
    'defaults read /Library/Preferences/com.apple.loginwindow GuestEnabled': '0\n',
    'defaults read /Library/Managed Preferences/com.apple.screensaver idleTime': '600\n',
    'defaults read /Library/Managed Preferences/com.apple.screensaver askForPassword': '1\n',
    '/usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate': 'Firewall is enabled. (State = 1)\n',
    'csrutil status': 'System Integrity Protection status: enabled.\n',
    'systemsetup -getusingnetworktime': 'Network Time: On\n',
  },
  linux: {
    'realm list --name-only': '',
    'apt-get -s -o Debug::NoLocking=1 upgrade': 'Reading package lists...\nInst openssl [3.0.13-0ubuntu3.1] (3.0.13-0ubuntu3.4 Ubuntu:24.04/noble-updates, Ubuntu:24.04/noble-security [amd64])\nInst vim [2:9.1.0016-1ubuntu7] (2:9.1.0016-1ubuntu7.2 Ubuntu:24.04/noble-updates [amd64])\n',
    'findmnt -n -o SOURCE /': '/dev/mapper/ubuntu--vg-ubuntu--lv\n',
    'lsblk -s -n -r -o NAME,TYPE /dev/mapper/ubuntu--vg-ubuntu--lv': 'ubuntu--vg-ubuntu--lv lvm\ndm_crypt-0 crypt\nnvme0n1p3 part\nnvme0n1 disk\n',
    'getent group sudo wheel admin': { ok: false, reason: 'command_failed', exitCode: 2, stdout: 'sudo:x:27:alice\n', stderr: '', error: 'exit 2' },
    'getent passwd guest': { ok: false, reason: 'command_failed', exitCode: 2, stdout: '', stderr: '', error: 'exit 2' },
    'ufw status': 'Status: active\n\nTo                         Action      From\n',
    'systemctl is-active ssh': { ok: false, reason: 'command_failed', exitCode: 4, stdout: 'inactive\n', stderr: '', error: 'exit 4' },
    'systemctl is-active sshd': { ok: false, reason: 'command_failed', exitCode: 3, stdout: 'inactive\n', stderr: '', error: 'exit 3' },
    'systemctl is-active xrdp': { ok: false, reason: 'command_failed', exitCode: 4, stdout: 'inactive\n', stderr: '', error: 'exit 4' },
    'systemctl is-active auditd': 'active\n',
    'mokutil --sb-state': 'SecureBoot enabled\n',
    'timedatectl show -p NTP --value': 'yes\n',
  },
};

/** osquery rows per platform, keyed by table name. */
const OSQUERY = {
  windows: {
    bitlocker_info: [
      { drive_letter: 'C:', conversion_status: '1', protection_status: '1', encryption_method: 'XTS_AES_128', percentage_encrypted: '100' },
      { drive_letter: 'D:', conversion_status: '0', protection_status: '0', encryption_method: 'None', percentage_encrypted: '0' },
    ],
    listening_ports: [
      { protocol: '6', port: '135', address: '0.0.0.0', name: 'svchost.exe' },
      { protocol: '6', port: '5040', address: '127.0.0.1', name: 'svchost.exe' },
    ],
    secureboot: [{ secure_boot: '1' }],
    tpm_info: [{ activated: '1', enabled: '1', spec_version: '2.0' }],
    processes: [{ name: 'MsMpEng.exe' }],
  },
  macos: {
    processes: [{ name: 'launchd' }, { name: 'falcond' }],
    sharing_preferences: [{ screen_sharing: '0', remote_login: '0', remote_management: '0' }],
    listening_ports: [{ protocol: '6', port: '5000', address: '::', name: 'ControlCenter' }],
    secureboot: [{ secure_boot: '2' }],
  },
  linux: {
    processes: [{ name: 'systemd' }, { name: 'falcon-sensor' }],
    listening_ports: [{ protocol: '6', port: '22', address: '0.0.0.0', name: 'sshd' }],
    secureboot: [{ secure_boot: '1' }],
  },
};

const FILES = {
  windows: {},
  macos: {
    '/Library/Apple/System/Library/CoreServices/XProtect.bundle/Contents/Info.plist': { mtime: '2026-10-19T00:00:00Z' },
  },
  linux: {
    '/var/lib/apt/periodic/update-success-stamp': { mtime: '2026-10-21T06:00:00Z' },
    '/var/log/apt/history.log': { text: 'Start-Date: 2026-10-15  02:10:00\nCommandline: apt upgrade\nEnd-Date: 2026-10-15  02:11:05\n' },
    '/etc/dconf/db/local.d/00-screensaver': { text: '[org/gnome/desktop/session]\nidle-delay=uint32 600\n\n[org/gnome/desktop/screensaver]\nlock-enabled=true\n' },
    '/proc/sys/kernel/randomize_va_space': { text: '2\n' },
    '/sys/firmware/efi/efivars': { text: '' },
  },
};

const SOFTWARE = [
  { name: '7-Zip 24.08 (x64)', version: '24.08', installedAt: null },
  { name: 'Google Chrome', version: '130.0.6723.59', installedAt: null },
];

function packsFor(platform, softwareItems = SOFTWARE) {
  const { IdentityPack } = dist('evidence/packs/identityPack');
  const { createEvidencePacks } = dist('evidence/packs');
  const software = () => ({ enabled: true, items: softwareItems, lastSyncedAt: new Date('2026-10-21T07:00:00Z') });
  // Same packs and order as production, with the identity source swapped for recorded data
  return createEvidencePacks({ software }).map((pack) => (pack.category === 'identity' ? new IdentityPack(IDENTITY[platform]) : pack));
}

function contextFor(platform, overrides = {}) {
  return context({
    platform,
    runner: new FakeRunner(overrides.commands ?? COMMANDS[platform]),
    osquery: new FakeOsquery(overrides.osquery ?? OSQUERY[platform], { available: overrides.osqueryAvailable ?? true }),
    files: new FakeFiles(overrides.files ?? FILES[platform]),
    elevated: overrides.elevated ?? true,
    runMode: overrides.runMode ?? 'service',
  });
}

async function envelopeFor(platform, overrides = {}) {
  const { EvidenceCollector } = dist('evidence/evidenceCollector');
  const { EvidenceHealthTracker } = dist('evidence/evidenceHealthTracker');
  const collector = new EvidenceCollector(packsFor(platform, overrides.software), new EvidenceHealthTracker(), () => '0123456789abcdef', '1.1.0');
  return collector.collect(contextFor(platform, overrides));
}

const scenarios = {
  'windows service': () => envelopeFor('windows'),
  'macos service': () => envelopeFor('macos'),
  'linux service': () => envelopeFor('linux'),
  'windows desktop (not elevated)': () => envelopeFor('windows', { elevated: false, runMode: 'desktop' }),
  'windows without osquery': () => envelopeFor('windows', { osqueryAvailable: false }),
  'linux without osquery': () => envelopeFor('linux', { osqueryAvailable: false, software: [] }),
  'windows with no tools at all': () => envelopeFor('windows', { commands: {}, osqueryAvailable: false }),
  'macos with no tools at all': () => envelopeFor('macos', { commands: {}, osqueryAvailable: false, files: {} }),
  'linux with no tools at all': () => envelopeFor('linux', { commands: {}, osqueryAvailable: false, files: {} }),
};

module.exports = { IDENTITY, COMMANDS, OSQUERY, FILES, WINDOWS_POWERSHELL, windowsPowerShell, contextFor, envelopeFor, scenarios };
