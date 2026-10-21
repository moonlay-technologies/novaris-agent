// Recorded OS outputs per platform and the envelopes the agent builds from them.
// Shared by the unit tests and by schema validation against the backend contract.
const path = require('path');
const { FakeRunner, FakeOsquery, context } = require('./evidenceFakes');

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

/** Command outputs per platform, keyed like FakeRunner expects. Extended by each category task. */
const COMMANDS = {
  windows: {
    'dsregcmd /status': 'AzureAdJoined : YES\nDomainJoined : NO\nMdmUrl : https://enrollment.manage.microsoft.com/x\n',
  },
  macos: {
    'profiles status -type enrollment': 'MDM enrollment: Yes (User Approved)\n',
    'dsconfigad -show': '',
  },
  linux: {
    'realm list --name-only': '',
  },
};

/** osquery rows per platform, keyed by table name. Extended by each category task. */
const OSQUERY = { windows: {}, macos: {}, linux: {} };

function packsFor(platform) {
  const { IdentityPack } = dist('evidence/packs/identityPack');
  const { createEvidencePacks } = dist('evidence/packs');
  // Same packs and order as production, with the identity source swapped for recorded data
  return createEvidencePacks().map((pack) => (pack.category === 'identity' ? new IdentityPack(IDENTITY[platform]) : pack));
}

async function envelopeFor(platform, overrides = {}) {
  const { EvidenceCollector } = dist('evidence/evidenceCollector');
  const { EvidenceHealthTracker } = dist('evidence/evidenceHealthTracker');
  const collector = new EvidenceCollector(packsFor(platform), new EvidenceHealthTracker(), () => '0123456789abcdef', '1.1.0');
  return collector.collect(
    context({
      platform,
      runner: new FakeRunner(overrides.commands ?? COMMANDS[platform]),
      osquery: new FakeOsquery(overrides.osquery ?? OSQUERY[platform], { available: overrides.osqueryAvailable ?? true }),
      elevated: overrides.elevated ?? true,
      runMode: overrides.runMode ?? 'service',
    }),
  );
}

const scenarios = {
  'windows service': () => envelopeFor('windows'),
  'macos service': () => envelopeFor('macos'),
  'linux service': () => envelopeFor('linux'),
  'windows desktop (not elevated)': () => envelopeFor('windows', { elevated: false, runMode: 'desktop' }),
  'linux without osquery': () => envelopeFor('linux', { osqueryAvailable: false }),
  'windows with no tools at all': () => envelopeFor('windows', { commands: {}, osqueryAvailable: false }),
};

module.exports = { IDENTITY, COMMANDS, OSQUERY, envelopeFor, scenarios };
