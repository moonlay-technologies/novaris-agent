// Tests for the category evidence packs, using recorded OS output only.
// Run with `npm test` (builds first).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createLogger } = require('../dist/utils/logger');
const { DEFAULT_CONFIG } = require('../dist/types/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-packs-test-'));
createLogger({ ...DEFAULT_CONFIG, logLevel: 'error', logFile: path.join(tmp, 'test.log') });

const { findForbiddenKeys } = require('./helpers/evidenceFakes');
const { contextFor, envelopeFor, scenarios, WINDOWS_POWERSHELL, windowsPowerShell, COMMANDS } = require('./helpers/evidenceFixtures');
const { PatchPack } = require('../dist/evidence/packs/patchPack');
const { ProtectionPack, decodeProductState } = require('../dist/evidence/packs/protectionPack');
const { EncryptionPack, parseManageBde } = require('../dist/evidence/packs/encryptionPack');
const { AccessPack, weakestScreenSaver, parseDconfLock } = require('../dist/evidence/packs/accessPack');
const { ExposurePack, nftablesActive, iptablesActive, bindScope } = require('../dist/evidence/packs/exposurePack');
const { HardeningPack } = require('../dist/evidence/packs/hardeningPack');
const { AuditPack, parseAuditpolCsv } = require('../dist/evidence/packs/auditPack');
const { SoftwarePack, inventoryHash } = require('../dist/evidence/packs/softwarePack');
const { parseRpmUpdateList, latestAptHistoryDate } = require('../dist/evidence/patchScanner');

const withPowerShell = (overrides) => ({ ...COMMANDS.windows, powershell: windowsPowerShell({ ...WINDOWS_POWERSHELL, ...overrides }) });
const failure = (exitCode, stdout = '', stderr = '') => ({ ok: false, reason: 'command_failed', exitCode, stdout, stderr, error: `exit ${exitCode}` });

test('every scenario produces all ten categories in catalog order', async () => {
  const order = ['identity', 'patch', 'protection', 'encryption', 'access', 'exposure', 'software', 'hardening', 'audit', 'agent'];
  for (const [name, build] of Object.entries(scenarios)) {
    const envelope = await build();
    assert.deepEqual(envelope.categories.map((c) => c.category), order, name);
    assert.deepEqual(findForbiddenKeys(envelope), [], name);
  }
});

test('no tools at all: nothing outside identity/agent/software claims a result', async () => {
  for (const platform of ['windows', 'macos', 'linux']) {
    const envelope = await envelopeFor(platform, { commands: {}, osqueryAvailable: false, files: {} });
    for (const category of envelope.categories) {
      if (['identity', 'agent', 'software'].includes(category.category)) continue;
      for (const [item, value] of Object.entries(category.items)) {
        // Facts that hold without any tool: no firewall program at all, and no UEFI firmware (BIOS boot)
        if (platform === 'linux' && `${category.category}.${item}` === 'exposure.firewall') {
          assert.equal(value.value.product, 'none');
          continue;
        }
        if (platform === 'linux' && `${category.category}.${item}` === 'hardening.secure_boot') {
          assert.deepEqual(value.value, { supported: false, enabled: null });
          continue;
        }
        assert.notEqual(value.status, 'ok', `${platform} ${category.category}.${item} must not claim a result without tools`);
      }
    }
  }
});

test('patch: Windows update scan maps to typed evidence', async () => {
  const items = await new PatchPack().collect(contextFor('windows'));
  assert.equal(items.updates.status, 'ok');
  assert.equal(items.updates.value.pending_total, 2);
  assert.equal(items.updates.value.pending_security, 1);
  assert.equal(items.updates.value.oldest_pending_security_days, 3);
  assert.equal(items.updates.value.package_manager, 'wua');
  assert.deepEqual(items.reboot.value, { reboot_pending: false, uptime_seconds: 86400 });
});

test('patch: a failed scan is an error, never "0 pending"', async () => {
  const commands = { ...COMMANDS.windows, powershell: () => failure(1) };
  const items = await new PatchPack().collect(contextFor('windows', { commands }));
  assert.equal(items.updates.status, 'error');
  assert.equal(items.updates.value, null);
});

test('patch: apt counts -security origins, reads history and reboot flag', async () => {
  const items = await new PatchPack().collect(contextFor('linux'));
  assert.equal(items.updates.value.pending_total, 2);
  assert.equal(items.updates.value.pending_security, 1);
  assert.equal(items.updates.value.last_scan_at, '2026-10-21T06:00:00.000Z');
  assert.equal(items.reboot.value.reboot_pending, false);
  assert.equal(latestAptHistoryDate('End-Date: 2026-10-15  02:11:05\nEnd-Date: 2026-10-16  01:00:00\n').getDate(), 16);
  assert.deepEqual(parseRpmUpdateList('openssl.x86_64  1:3.0.7-28.el9  baseos\nObsoleting Packages\nfoo.noarch 1 repo\n'), ['openssl.x86_64']);
});

test('patch: macOS has no staged reboot state (not applicable)', async () => {
  const items = await new PatchPack().collect(contextFor('macos'));
  assert.equal(items.updates.value.pending_security, 1);
  assert.equal(items.reboot.status, 'not_applicable');
});

test('protection: Security Center state decoding and Defender details', async () => {
  assert.deepEqual(decodeProductState(397568), { realtime: true, upToDate: true }); // 0x061100
  assert.deepEqual(decodeProductState(393472), { realtime: false, upToDate: true }); // 0x060100
  assert.deepEqual(decodeProductState(397584), { realtime: true, upToDate: false }); // 0x061110

  const items = await new ProtectionPack().collect(contextFor('windows'));
  const [defender] = items.antimalware.value.products;
  assert.equal(defender.realtime_enabled, true);
  assert.equal(defender.signature_age_days, 0);
  assert.equal(defender.tamper_protected, true);
});

test('protection: Defender in passive mode is not counted as real-time', async () => {
  const commands = withPowerShell({
    'Get-MpComputerStatus': {
      defender: { realtime: true, signature_age: 1, tamper: false, mode: 'Passive Mode' },
      products: [{ displayName: 'Windows Defender', productState: 393472 }, { displayName: 'CrowdStrike Falcon Sensor', productState: 266240 }],
    },
  });
  const { products } = (await new ProtectionPack().collect(contextFor('windows', { commands }))).antimalware.value;
  assert.equal(products.find((p) => /defender/i.test(p.name)).realtime_enabled, false);
  assert.equal(products.find((p) => /crowdstrike/i.test(p.name)).kind, 'edr');
});

test('protection: macOS reports XProtect, Gatekeeper and running EDR', async () => {
  const value = (await new ProtectionPack().collect(contextFor('macos'))).antimalware.value;
  assert.equal(value.gatekeeper_enabled, true);
  assert.deepEqual(value.products.map((p) => [p.name, p.kind]), [['XProtect', 'builtin'], ['CrowdStrike Falcon', 'edr']]);
  assert.equal(value.products[0].signature_age_days, 2);
});

test('encryption: system volume is judged on its own, other volumes are counted', async () => {
  const items = await new EncryptionPack(() => 'C:').collect(contextFor('windows'));
  assert.deepEqual(items.system_volume.value, { volume: 'C:', encrypted: true, method: 'XTS_AES_128', protection_on: true });
  assert.deepEqual(items.other_volumes.value, { total: 1, encrypted: 0 });

  const dOnly = contextFor('windows', { osquery: { bitlocker_info: [{ drive_letter: 'D:', conversion_status: '1', protection_status: '1' }] } });
  assert.equal((await new EncryptionPack(() => 'C:').collect(dOnly)).system_volume.value.encrypted, false);
});

test('encryption: unprivileged empty bitlocker_info is unknown; manage-bde parsing', async () => {
  const items = await new EncryptionPack(() => 'C:').collect(contextFor('windows', { elevated: false, osquery: { bitlocker_info: [] } }));
  assert.equal(items.system_volume.reason, 'insufficient_privilege');

  assert.deepEqual(parseManageBde('Volume C: [OS]\n    Conversion Status:    Fully Encrypted\n    Encryption Method:    XTS-AES 128\n    Protection Status:    Protection Off\n'), {
    volume: 'C:', encrypted: true, method: 'XTS-AES 128', protection_on: false,
  });
});

test('encryption: LUKS under LVM is found through lsblk parents', async () => {
  const items = await new EncryptionPack().collect(contextFor('linux'));
  assert.deepEqual(items.system_volume.value, { volume: '/', encrypted: true, method: 'LUKS', protection_on: null });
});

test('access: admins, default accounts and machine screen lock policy (Windows)', async () => {
  const items = await new AccessPack().collect(contextFor('windows'));
  assert.equal(items.local_admins.value.count, 2);
  assert.deepEqual(items.local_admins.value.members[1], { name: 'CORP\\IT-Admins', type: 'group', scope: 'domain', enabled: null });
  assert.equal(items.local_admins.value.members[0].enabled, false);
  assert.deepEqual(items.screen_lock.value, { enabled: true, timeout_seconds: 600, password_on_wake: true, scope: 'machine_policy' });
  assert.deepEqual(items.default_accounts.value, { guest_enabled: false, builtin_admin_enabled: false });
});

test('access: weakest screen saver wins across signed-in users', () => {
  assert.equal(weakestScreenSaver([{ active: '1', secure: '1', timeout: '300' }, { active: '0', secure: '1', timeout: '300' }], 'console_user').enabled, false);
  assert.equal(weakestScreenSaver([{ active: '1', secure: '1', timeout: '300' }, { active: '1', secure: '0', timeout: '1800' }], 'console_user').timeout_seconds, 1800);
  assert.equal(parseDconfLock(['[org/gnome/desktop/session]\nidle-delay=uint32 0\n']).enabled, false);
});

test('access: macOS excludes root; Linux reads sudo group and dconf policy', async () => {
  const mac = await new AccessPack().collect(contextFor('macos'));
  assert.deepEqual(mac.local_admins.value.members.map((m) => m.name), ['alice']);
  assert.equal(mac.screen_lock.value.timeout_seconds, 600);

  const linux = await new AccessPack().collect(contextFor('linux'));
  assert.deepEqual(linux.local_admins.value.members.map((m) => m.name), ['alice']);
  assert.deepEqual(linux.screen_lock.value, { enabled: true, timeout_seconds: 600, password_on_wake: true, scope: 'machine_policy' });
  assert.equal(linux.default_accounts.value.guest_enabled, false);
});

test('exposure: firewall per profile, remote access and ports', async () => {
  const items = await new ExposurePack().collect(contextFor('windows'));
  assert.equal(items.firewall.value.profiles.length, 3);
  assert.equal(items.remote_access.value.rdp_enabled, false);
  assert.deepEqual(items.listening_ports.value.ports.map((p) => [p.port, p.bind_scope]), [[135, 'any'], [5040, 'loopback']]);
  assert.equal(bindScope('::1'), 'loopback');
});

test('exposure: Linux firewall detection order and parsers', async () => {
  const items = await new ExposurePack().collect(contextFor('linux'));
  assert.deepEqual(items.firewall.value, { product: 'ufw', profiles: [{ name: 'global', enabled: true }] });
  assert.equal(items.remote_access.value.ssh_server_enabled, false);
  assert.ok(nftablesActive('table inet filter {\n chain input {\n  type filter hook input priority 0; policy drop;\n }\n}'));
  assert.ok(!nftablesActive('table inet filter {\n chain input {\n  type filter hook input priority 0; policy accept;\n }\n}'));
  assert.ok(iptablesActive('-P INPUT ACCEPT\n-A INPUT -p tcp --dport 22 -j ACCEPT\n'));
  assert.ok(!iptablesActive('-P INPUT ACCEPT\n'));
});

test('exposure: ufw needing root is unknown, not "off"', async () => {
  const commands = { 'ufw status': failure(1, '', 'ERROR: You need to be root') };
  const items = await new ExposurePack().collect(contextFor('linux', { commands, elevated: false }));
  assert.equal(items.firewall.status, 'unknown');
  assert.equal(items.firewall.reason, 'insufficient_privilege');
});

test('hardening: secure boot, TPM and baseline', async () => {
  const windows = await new HardeningPack().collect(contextFor('windows'));
  assert.deepEqual(windows.secure_boot.value, { supported: true, enabled: true });
  assert.deepEqual(windows.tpm.value, { present: true, ready: true, version: '2.0' });
  assert.deepEqual(windows.baseline.value.settings, {
    'windows.smb1_enabled': false, 'windows.autorun_disabled': true, 'windows.llmnr_disabled': true, 'windows.uac_enabled': true,
  });

  const mac = await new HardeningPack().collect(contextFor('macos'));
  assert.deepEqual(mac.baseline.value.settings, { 'macos.sip_enabled': true, 'macos.gatekeeper_enabled': true });
});

test('hardening: Windows without osquery falls back to PowerShell; BIOS is unsupported', async () => {
  const commands = withPowerShell({ 'Confirm-SecureBootUEFI': { supported: false, enabled: null, error: null } });
  const items = await new HardeningPack().collect(contextFor('windows', { commands, osqueryAvailable: false }));
  assert.deepEqual(items.secure_boot.value, { supported: false, enabled: null });
  assert.equal(items.tpm.source, 'powershell:Get-Tpm');
});

test('audit: auditpol CSV maps GUIDs to ids; macOS logging is not applicable', async () => {
  const csv = ['h', 'X,System,Logon,{0CCE9215-69AE-11D9-BED3-505054503030},Success and Failure,'].join('\n');
  assert.deepEqual(parseAuditpolCsv(csv), [{ id: 'logon', success: true, failure: true }]);
  const windows = await new AuditPack().collect(contextFor('windows'));
  assert.equal(windows.logging.value.security_log_max_mb, 20);
  assert.equal(windows.logging.value.categories.length, 3);
  assert.equal(windows.time_sync.value.enabled, true);
  assert.equal((await new AuditPack().collect(contextFor('macos'))).logging.status, 'not_applicable');
});

test('software: empty inventory without osquery is unknown; hash is order-independent', async () => {
  const empty = new SoftwarePack(() => ({ enabled: true, items: [], lastSyncedAt: null }));
  assert.equal((await empty.collect(contextFor('linux', { osqueryAvailable: false }))).inventory.reason, 'tool_unavailable');
  const a = [{ name: 'A', version: '1' }, { name: 'B', version: '2' }];
  assert.equal(inventoryHash(a), inventoryHash([...a].reverse()));
});
