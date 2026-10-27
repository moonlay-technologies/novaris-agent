# 05 — Action Plan

**No code was changed in this audit.** This is a backlog proposal for product-owner review. Backend/UI items are listed only where the agent change depends on them.

Collector strategy: **reuse the current stack**. That means PowerShell/CIM on Windows, the bundled `osqueryi`, and native CLIs on macOS/Linux. osquery already provides most of the new P0/P1 signals across all three OSes:
- `logged_in_users` / `users` / `user_groups` (local admins);
- `listening_ports`;
- `secureboot`;
- `windows_security_center`;
- `alf`;
- `sip_config`;
- `mdm` (macOS).

No new agent, tool or npm package is needed.

---

## E. Trustworthiness foundation (do first; the rest depends on it)

| ID | Item | Why | Acceptance criteria / tests |
|---|---|---|---|
| **A1** P0 | **Per-check status envelope**: every check returns `status ∈ {ok, unknown, error, not_applicable}` + `source` + `error_code`. Stop defaulting to `false`/`0`. | Today failures produce false PASS (patch) and false FAIL (encryption, macOS AV). | Unit test per collector: simulated command failure → `status:error`, value `null`. Patch collector with WUA throwing → never `missing_critical:false`. |
| **A2** P0 | **Agent & evidence health block**: run_mode (service/desktop), elevated, osquery_available (use the existing `isOsqueryAvailable()`), per-collector last_success_at/last_error, config hash, schema_version. | Lets the server show UNKNOWN/STALE instead of PASS, and explains missing data. | Remove the osquery binary in a test → health shows `osquery_available:false` and encryption/software checks show `unknown`. |
| **A3** P0 | **Refresh identity on change**: hash identity fields each health cycle and re-send when changed (OS version/build, IP/MAC, hostname). | OS version is currently frozen at registration. | Change the mocked `si.osInfo` release → next cycle sends the new identity. |
| **A4** P0 | **Durable offline queue** (bounded, on disk, oldest-dropped) with original `collected_at`. | In-memory queues lose evidence on reboot, which is common on laptops. | Kill the agent while offline → the queue survives restart; the cap is enforced. |
| **A5** P0 (with backend) | **Transport trust**: refuse non-HTTPS `apiUrl` in production builds; per-device credential issued at registration instead of a shared fleet API key; sign Windows builds (`package.json` currently `"sign": null`). | Fake or tampered results; key leakage. | Agent refuses `http://` when `NODE_ENV=production`; integration test with a rotated device token. |

## P0 — Essential MVP evidence

| ID | Item | Depends | Quick win? | Acceptance criteria / tests |
|---|---|---|---|---|
| **P0-1** | **Patch**: typed `pending_security`, `reboot_pending` (W: registry `RebootRequired`/`CBS RebootPending`; L/M: already computed, move out of `details`), `last_install_at` (W: `Get-HotFix`/WUA history latest; L: `/var/log/apt/history.log` mtime / `rpm -qa --last`; M: `softwareupdate --history`). Run `softwareupdate -l` once, not twice. | A1 | ✅ reuse | Fixture outputs for apt/dnf/zypper/softwareupdate/WUA JSON → expected typed fields; failure → `status:error`. |
| **P0-2** | **AV**: fix the Windows third-party logic (a registered product is not the same as enabled); send `products[] {name, realtime, signature_age_days\|up_to_date}`; macOS: XProtect version + Gatekeeper `spctl --status` + known EDR detection from the software/launchd list; Linux: allowlist of EDR systemd units (configurable) in addition to ClamAV. Remove the agent-side 7-day verdict. | A1 | partly | productState fixtures (e.g. `397568`, `393472`, `266240`) → correct real-time/up-to-date flags; macOS returns `unknown`, not `false`, when nothing is detectable. |
| **P0-3** | **Firewall**: Windows per-profile booleans; PASS rule server-side = all applicable profiles on. Linux: add an `nft list ruleset` / `iptables -S` non-empty fallback; distinguish "not installed" from "not permitted". | A1 | ✅ | Domain+Private on, Public off → server rule FAIL. |
| **P0-4** | **Encryption**: report the **system volume** explicitly (W: `%SystemDrive%`; M: root APFS volume; L: device backing `/`), method, protection_on; other volumes as a count. Never query key-protector or recovery tables. | A1, A2 | ✅ | BitLocker on D: only → system volume `encrypted:false`. Test asserts the osquery SQL selects no recovery-key columns. |
| **P0-5** | **Local admins**: W `Get-LocalGroupMember -SID S-1-5-32-544`; M `dscl . -read /Groups/admin GroupMembership`; L `getent group sudo wheel admin`. Send account name + local/domain type + count. | A1 | new, small | Fixtures per OS; domain groups reported as groups, not expanded. |
| **P0-6** | **Screen lock**: W machine policy `InactivityTimeoutSecs` + screensaver policy (`ScreenSaveTimeOut`, `ScreenSaverIsSecure` from policy hive); M `sysadminctl -screenLock status` + `com.apple.screensaver` managed prefs; L best effort (`gsettings` for the console user, else `unknown`). | A1 | new | When no policy is set → `lock_timeout_sec:null, status:ok` (a FAIL decided server-side), not `unknown`. |
| **P0-7** | **Software inventory hardening**: remove the dead `si.apps()` path; add publisher (osquery `programs.publisher`, `apps.bundle_identifier`, deb `maintainer`/rpm `vendor`); send an empty list explicitly with `status`; hash-based "unchanged" short-circuit. | A1, A2 | ✅ | osquery missing → `status:error`, backend list not wiped and not marked fresh. |
| **P0-8** | **Privacy reductions (quick wins, config-only first)**: default `collectProcesses=false`; stop sending `command`; drop SSID/BSSID; disable scheduled YARA (keep `scan_path`); stop sending software-risk data from the agent. | — | ✅ config | Payload snapshot tests contain no `command`, `ssid`, `bssid`. |

## P1 — Next phase

| ID | Item | Notes |
|---|---|---|
| P1-1 | Secure Boot/TPM on M/L (osquery `secureboot` on Linux, `mokutil`; macOS chip/SIP via `sip_config`) and typed on W | Hardening category |
| P1-2 | Remote access: RDP enabled + NLA (W registry), SSH server (all), macOS Remote Login / Screen Sharing | Exposure category |
| P1-3 | Listening-ports summary (osquery `listening_ports`), aggregated | No remote peers |
| P1-4 | Audit configuration: W `auditpol /get /category:* /r` (selected subcategories), Security log size; L `auditd` active; M unified-log/`audit_control` presence | Replaces raw log collection |
| P1-5 | Join/MDM state (W `dsregcmd /status`; M osquery `mdm`; L `realm list`) | Ownership/management |
| P1-6 | Small hardening baseline (≤10 settings, versioned `baseline_id`): SMBv1, AutoRun, Guest account, SIP, Gatekeeper, LLMNR (W) | Company baseline, configurable |
| P1-7 | Narrow event stream: Defender detections (1116/1117), WU failures; no free-text messages | Replaces `/logs` default |
| P1-8 | Server-side: CVE correlation, OS end-of-life, unapproved-software rules (DERIVE) | Backend |
| P1-9 | Local password/lockout policy (W `net accounts` or `secedit` export subset) | Often better sourced from the IdP/GPO |

## P2 — Optional

USB mass-storage policy state · time-sync configuration/offset · macOS firewall stealth mode · tamper protection on M/L · baseline drift diffs.

## OUT OF SCOPE (endpoint compliance)

Network-gateway features (syslog/SNMP/discovery/Zeek), Wi-Fi telemetry, continuous process monitoring, scheduled content scanning, the AI runtime (`runtime/`).

---

## Top 10 in recommended order

1. **A1** status envelope (removes false PASS/FAIL)
2. **P0-8** privacy quick wins (config defaults; immediate risk reduction)
3. **A2** agent & evidence health
4. **A3** identity refresh
5. **P0-1** patch: reboot pending + last install + typed fields
6. **P0-4** encryption: system volume
7. **P0-2** AV fixes incl. macOS
8. **P0-3** firewall per profile
9. **P0-5** local admins + **P0-6** screen lock
10. **A4/A5** durable queue + transport trust (with backend)

## Testing approach

There are currently no collector tests (`test/` covers only `agentRuntime` and `userSession`). Recommended:
- **Fixture-based unit tests.** Inject a command runner so each collector parses recorded outputs (PowerShell JSON, osquery JSON, apt/dnf/zypper/softwareupdate text) with no real host access. This also satisfies "no invasive collection on employee devices".
- **Payload contract snapshots** per category, plus a forbidden-key test (`command`, `ssid`, `bssid`, `password`, `recovery`).
- **VM smoke tests** (Windows 11, macOS 14+, Ubuntu 24.04, RHEL 9) in service mode and desktop mode, capturing one payload per category.

## Open questions for the product owner

1. **Product positioning:** is Novaris an asset/compliance tool, or also EDR-lite? This decides whether processes/logs/YARA stay as optional streams or are removed.
2. Should the agent report the **primary/console user** for ownership (personal data) or rely on the asset register?
3. Is **macOS without third-party AV** (XProtect + Gatekeeper only) acceptable under company malware policy? This decides whether macOS can ever PASS P0-2.
4. Company thresholds: signature age, patch SLA by severity, screen-lock timeout, allowed admin accounts.
5. Is **desktop (non-elevated) mode** a supported production deployment? If yes, several checks will always be `unknown` there.
6. Who issues **per-device credentials**, and is HTTPS guaranteed in all deployments?
7. Are peripheral serials needed for asset management (keep reduced) or not (remove)?
8. Retention period required by GRC for evidence history.

## Assumptions

- Backend endpoints accept the current payloads as they are; their behaviour was not verified.
- The ISO 27001:2022 control numbers and titles are correct, but the wording of each requirement is unverified (no licensed text was available).
- Volume figures in 04 are estimates.
