// Tests for compliance evidence collection. Run with `npm test` (builds first).
// Uses Node's built-in test runner against the compiled output and recorded
// command/osquery output only - nothing is read from the machine running the tests.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLogger } = require('../dist/utils/logger');
const { DEFAULT_CONFIG } = require('../dist/types/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-evidence-test-'));
createLogger({ ...DEFAULT_CONFIG, logLevel: 'error', logFile: path.join(tmp, 'test.log') });

const { EvidenceCollector } = require('../dist/evidence/evidenceCollector');
const { EvidenceHealthTracker } = require('../dist/evidence/evidenceHealthTracker');
const { IdentityPack, parseDsregcmd } = require('../dist/evidence/packs/identityPack');
const { configHash } = require('../dist/evidence/runtimeInfo');
const { FakeRunner, FakeOsquery, context, findForbiddenKeys } = require('./helpers/evidenceFakes');

const identitySource = (overrides = {}) => ({
  osInfo: async () => ({ distro: 'Microsoft Windows 11 Pro', release: '10.0.26200', build: '26200', arch: 'x64', hostname: 'LAPTOP-0001' }),
  system: async () => ({ manufacturer: 'LENOVO', model: '20XW', serial: 'PF3ABC12' }),
  defaultInterface: async () => ({ ip4: '10.0.4.21', mac: '00:11:22:33:44:55' }),
  hostname: () => 'LAPTOP-0001',
  ...overrides,
});

const DSREGCMD_ENTRA = `
+----------------------------------------------------------------------+
| Device State                                                         |
+----------------------------------------------------------------------+
             AzureAdJoined : YES
          EnterpriseJoined : NO
              DomainJoined : NO
+----------------------------------------------------------------------+
| Tenant Details                                                       |
+----------------------------------------------------------------------+
                    MdmUrl : https://enrollment.manage.microsoft.com/enrollmentserver/discovery.svc
`;

test('identity: reports device facts and normalises placeholder serials', async () => {
  const pack = new IdentityPack(identitySource({ system: async () => ({ manufacturer: 'LENOVO', model: '20XW', serial: 'To be filled by O.E.M.' }) }));
  const items = await pack.collect(context({ runner: new FakeRunner({ 'dsregcmd /status': DSREGCMD_ENTRA }) }));

  assert.equal(items.device.status, 'ok');
  assert.equal(items.device.value.serial_number, null);
  assert.equal(items.device.value.os_family, 'windows');
  assert.equal(items.device.value.os_edition, 'Pro');
  assert.equal(items.device.value.primary_mac, '00:11:22:33:44:55');
  assert.deepEqual(items.management.value, { join_type: 'entra', mdm_enrolled: true, mdm_server: 'Microsoft Intune' });
});

test('identity: dsregcmd parsing covers hybrid and unmanaged devices', () => {
  assert.equal(parseDsregcmd('AzureAdJoined : YES\nDomainJoined : YES\n').join_type, 'hybrid');
  assert.deepEqual(parseDsregcmd('AzureAdJoined : NO\nDomainJoined : NO\n'), { join_type: 'none', mdm_enrolled: null, mdm_server: null });
});

test('identity: missing OS facts are unknown, a throwing source is an error', async () => {
  const empty = new IdentityPack(identitySource({ osInfo: async () => ({ distro: '', release: '', build: '', arch: '', hostname: 'x' }) }));
  assert.equal((await empty.collect(context())).device.status, 'unknown');

  const broken = new IdentityPack(identitySource({ system: async () => { throw new Error('WMI unavailable'); } }));
  const item = (await broken.collect(context())).device;
  assert.equal(item.status, 'error');
  assert.equal(item.value, null);
});

test('identity: management probe without the tool is unknown, never "none"', async () => {
  const pack = new IdentityPack(identitySource());
  const items = await pack.collect(context({ platform: 'linux' }));
  assert.equal(items.management.status, 'unknown');
  assert.equal(items.management.reason, 'tool_unavailable');
});

test('identity: macOS reads MDM enrollment from profiles', async () => {
  const runner = new FakeRunner({
    'profiles status -type enrollment': 'Enrolled via DEP: Yes\nMDM enrollment: Yes (User Approved)\n',
    'dsconfigad -show': '',
  });
  const items = await new IdentityPack(identitySource()).collect(context({ platform: 'macos', runner }));
  assert.deepEqual(items.management.value, { join_type: 'none', mdm_enrolled: true, mdm_server: null });
});

test('collector: envelope carries identity + agent health and tracks collector errors', async () => {
  const tracker = new EvidenceHealthTracker();
  const failing = { category: 'identity', collect: async () => { throw new Error('boom'); } };
  const collector = new EvidenceCollector([failing], tracker, () => 'abc', '1.1.0');

  const envelope = await collector.collect(context({ osquery: new FakeOsquery({}, { available: false }) }));
  assert.equal(envelope.schema_version, 1);
  assert.deepEqual(envelope.categories.map((c) => c.category), ['agent'], 'failed pack is left out, not faked');

  const health = envelope.categories[0].items.health.value;
  assert.equal(health.osquery_available, false);
  assert.equal(health.osquery_version, null);
  assert.equal(health.collectors[0].category, 'identity');
  assert.equal(health.collectors[0].last_error, 'boom');
  assert.equal(health.collectors[0].last_success_at, null);
});

test('collector: full envelope contains no forbidden keys', async () => {
  const runner = new FakeRunner({ 'dsregcmd /status': DSREGCMD_ENTRA });
  const collector = new EvidenceCollector([new IdentityPack(identitySource())], new EvidenceHealthTracker(), () => 'abc', '1.1.0');
  const envelope = await collector.collect(context({ runner }));
  assert.deepEqual(envelope.categories.map((c) => c.category), ['identity', 'agent']);
  assert.deepEqual(findForbiddenKeys(envelope), []);
});

test('config hash ignores secrets and device-specific state', () => {
  const base = { ...DEFAULT_CONFIG, apiUrl: 'https://x', apiKey: 'secret-1', assetTag: 'A1', deviceId: 1 };
  assert.equal(configHash(base), configHash({ ...base, apiKey: 'secret-2', deviceId: 2 }));
  assert.notEqual(configHash(base), configHash({ ...base, evidenceInterval: 60 }));
});

test('privacy defaults: processes and scheduled YARA are off, evidence is on', () => {
  assert.equal(DEFAULT_CONFIG.collectProcesses, false);
  assert.equal(DEFAULT_CONFIG.collectYaraScan, false);
  assert.equal(DEFAULT_CONFIG.collectEvidence, true);
});

module.exports = { identitySource };
