# 02 — Compliance Gap Matrix (Windows, macOS, Linux)

## Standards used and how far to trust the mappings

| Framework | Version | Source | Confidence |
|---|---|---|---|
| ISO/IEC 27001 Annex A | 2022 (93 controls, themes 5–8) | Public control titles. The licensed full text was **not** available. | Control **numbers and titles**: high. Wording of requirements: **NEEDS VALIDATION** against a licensed copy before use in an audit pack. |
| NIST CSF | 2.0 (Feb 2024) | https://doi.org/10.6028/NIST.CSWP.29 | High for function/category; medium for subcategory IDs (marked where unsure). |
| NIST SP 800-53 | Rev. 5 | https://doi.org/10.6028/NIST.SP.800-53r5 | High for base controls; enhancements marked. |
| NIST SP 800-40 | Rev. 4 (patch mgmt) | https://doi.org/10.6028/NIST.SP.800-40r4 | Context only. |

**Important:**
- No ISO or NIST control *requires* a specific endpoint field. Each check below **supports** a control by producing technical evidence for it, or for the company's own implementation of it. Thresholds such as "signatures ≤ 7 days" or "lock ≤ 15 min" are **company policy** and must stay configurable.
- Endpoint evidence never establishes ISO certification or organisational compliance on its own (see §3).

Legend:
- **Alone/Partial/No** = whether endpoint data can substantiate the outcome by itself.
- **Status** = current agent state: ✅ exists and is reliable · ⚠️ exists but unreliable or incomplete · ❌ missing.
- **P** = P0 essential MVP · P1 next phase · P2 optional · OOS out of scope.

---

## 1. Endpoint technical evidence matrix

| # | Risk / outcome | Evidence check | Minimum fields | Status W / M / L | ISO 27001:2022 | NIST CSF 2.0 | NIST 800-53 r5 | Alone? | P | Validation notes |
|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Unknown or unmanaged devices | Device is in inventory with current identity | serial, hostname, os_family, os_version+build, model, last_seen, asset_tag | ⚠️⚠️⚠️ OS/IP/MAC sent once only; no model or build | 5.9 Inventory of information and other associated assets; 8.1 User endpoint devices | ID.AM-01 | CM-8 | Partial (ownership is a process fact) | **P0** | Re-send identity on change. |
| 2 | Device ownership/management | Domain/Entra/MDM enrollment state | join_type (none/domain/entra/hybrid), mdm_enrolled (bool) | ❌❌❌ | 8.1; 5.9 | ID.AM-01; PR.AA-01 (medium) | CM-8(4) (medium); AC-19 | Partial | P1 | W: `dsregcmd /status`; M: `profiles status -type enrollment`; L: `realm list` / sssd. |
| 3 | Unsupported OS | OS version within vendor support | os_family, os_version, build, edition | ⚠️ data stale, no build | 8.8 Management of technical vulnerabilities; 8.1 | ID.AM-02 (medium); PR.PS-02 | SA-22 Unsupported system components | Alone (with a server-side EOL table) | **P0** | **DERIVE** EOL server-side. Do not collect it on the agent. |
| 4 | Missing security updates | Pending security updates, freshness of last scan | pending_total, pending_security, last_successful_scan_at, last_install_at, check_status | ⚠️⚠️⚠️ failure becomes false PASS; no last-install date | 8.8; 8.19 (medium) | ID.RA-01; PR.PS-02 | SI-2; SI-2(2) (medium); RA-5 | Alone | **P0** | Policy sets the threshold (e.g. security update > N days). |
| 5 | Patches staged but not active | Reboot pending | reboot_pending (bool), uptime_days | ❌ W / ⚠️ M,L (free text only) | 8.8 | PR.PS-02 | SI-2 | Alone | **P0** | W: `HKLM\...\WindowsUpdate\Auto Update\RebootRequired`, `CBS\RebootPending`. Uptime already exists. |
| 6 | Malware protection absent/off | AV/EDR present, real-time on, signatures fresh | av_present, av_product[], realtime_enabled, signature_age_days, check_status | ⚠️ W (3rd-party false PASS) / ❌ M (always false) / ⚠️ L (ClamAV only) | 8.7 Protection against malware | DE.CM-09; PR.PS-01 (medium) | SI-3 | Alone | **P0** | M: XProtect version + Gatekeeper (`spctl --status`) + known EDR from inventory. L: known EDR services from an allowlist. |
| 7 | Protection can be disabled by the user | Tamper protection | tamper_protected (bool/unknown) | ⚠️ W (metadata only) / ❌ M,L | 8.7 | PR.PS-01 | SI-3; SI-7 (medium) | Partial | P1 | Promote it from metadata to a typed field. |
| 8 | Host exposed on untrusted networks | Host firewall enabled on **all** profiles | fw_enabled_per_profile{domain,private,public} / fw_enabled, fw_product | ⚠️ W ("any profile" = pass) / ✅ M / ⚠️ L (ufw needs root; no nft) | 8.20 Networks security; 8.1 | PR.IR-01; PR.PS-01 | SC-7; SC-7(12) Host-based protection (medium) | Alone | **P0** | M: also stealth mode (P2). |
| 9 | Data exposure on loss/theft | **System volume** encrypted, protection on | sys_volume_encrypted, method, protection_on, check_status — **never recovery keys** | ⚠️⚠️⚠️ "any volume" logic; osquery-missing becomes false FAIL | 8.1; 8.24 Use of cryptography; 7.10 Storage media (medium) | PR.DS-01 | SC-28; SC-28(1); SC-13 | Alone | **P0** | |
| 10 | Excess privilege | Local admin group membership | admin_members[] (account name + type local/domain), admin_count | ❌❌❌ | 8.2 Privileged access rights; 5.15 Access control | PR.AA-05 | AC-6; AC-6(5); AC-2 | Partial (approval is a process fact) | **P0** | W: `Get-LocalGroupMember -SID S-1-5-32-544`; M: `dscl . -read /Groups/admin`; L: `getent group sudo wheel`. Names only. |
| 11 | Dormant/default accounts | Built-in Guest/Administrator enabled, local account list | guest_enabled, builtin_admin_enabled, local_account_count | ❌ | 5.18 Access rights; 8.2 | PR.AA-01 (medium) | AC-2; AC-2(3) (medium) | Partial | P1 | Do not collect last-logon times unless the policy needs them. |
| 12 | Unattended unlocked session | Screen lock / inactivity timeout | lock_enabled, lock_timeout_sec, password_on_wake | ❌❌❌ | 7.7 Clear desk and clear screen; 8.1 | PR.AA-03 (medium); PR.PS-01 | AC-11; AC-11(1) | Partial (effective value is per user) | **P0** W,M / P1 L | W: `InactivityTimeoutSecs` policy + screensaver policy. M: `sysadminctl -screenLock status`. L: gsettings per user (hard as root). |
| 13 | Weak local authentication | Local password/lockout policy | min_length, lockout_threshold, (W) `net accounts` | ❌ | 8.5 Secure authentication | PR.AA-03 | IA-5(1); AC-7 | Partial (usually set by IdP/GPO) | P1 | Often better sourced from AD/Entra/MDM than the endpoint. |
| 14 | Boot-level compromise | Secure Boot on, TPM present/ready | secure_boot, tpm_present, tpm_ready | ⚠️ W (metadata only) / ❌ M / ❌ L | 8.9 Configuration management; 8.1 | PR.PS-01 | SI-7(9) Verify boot process (medium); SC-51 (low) | Alone | P1 | M: Apple silicon has it implicitly; report the chip. L: `mokutil --sb-state`. |
| 15 | Insecure baseline | Small hardening set (e.g. SMBv1 off, AutoRun off, Gatekeeper on, SIP on) | per-setting bool + baseline_id | ❌ | 8.9 | PR.PS-01 | CM-6; CM-7 | Alone (vs a defined baseline) | P1 | Keep it to ≤ 10 settings; avoid full CIS dumps. |
| 16 | Unapproved software | Installed software vs allow/deny list | name, version, publisher, (install_scope) | ⚠️ inventory exists; no publisher; empty-list case swallowed | 8.19 Installation of software on operational systems; 5.32 Intellectual property rights (licensing) | ID.AM-02; PR.PS-05 (medium) | CM-11; CM-10; CM-7(5) (medium) | Alone (vs policy list) | **P0** (inventory) | Evaluate the deny/allow list **server-side**. The current keyword heuristic is low precision (see 04). |
| 17 | Known-vulnerable software | CVE correlation | same as 16 + normalised vendor/product | ❌ (no correlation) | 8.8 | ID.RA-01 | RA-5; SI-2 | Partial (depends on the CPE match quality) | P1 | **DERIVE** server-side from NVD/vendor feeds. No agent change beyond adding publisher. |
| 18 | Unauthorised remote access | RDP / SSH server / Screen Sharing / Remote Login enabled; RDP NLA | rdp_enabled, rdp_nla, ssh_server_enabled, mac_remote_login, mac_screen_sharing | ❌❌❌ | 8.20; 5.15 (medium) | PR.AA-05 (medium); PR.IR-01 | AC-17; CM-7 | Alone | P1 | |
| 19 | Unnecessary exposed services | Listening ports summary | listening (proto, port, process_name) — no remote addresses | ❌ | 8.20; 8.9 | PR.PS-01 | CM-7 | Alone | P1 | osquery `listening_ports`. Aggregate only; no connection table. |
| 20 | Removable-media data loss | USB mass-storage policy | usb_storage_blocked (bool) | ❌ (peripheral inventory exists, but not policy) | 7.10 Storage media; 8.12 Data leakage prevention (medium) | PR.DS-01 (medium) | MP-7 | Alone | P2 | Policy state, not a list of plugged devices. |
| 21 | No forensic trail | Audit policy configured, log service running, log size/retention | audit_policy_ok (per category bool), eventlog_service, security_log_max_mb / auditd_running / mac unified log | ❌ | 8.15 Logging | PR.PS-04 | AU-2; AU-12; AU-4 (medium) | Partial (central collection is elsewhere) | P1 | W: `auditpol /get /category:* /r`. Collect **configuration**, not events. |
| 22 | Inaccurate timestamps | Time sync configured, offset | time_sync_enabled, ntp_source, offset_sec | ❌ | 8.17 Clock synchronization | PR.PS-04 (low) | AU-8 | Alone | P2 | |
| 23 | Monitoring coverage gaps / stale evidence | Agent health and evidence freshness | agent_version, run_mode (service/desktop), elevated, osquery_available, per-collector {last_success_at, status, error_code}, config_hash | ⚠️ agent_version only | 8.16 Monitoring activities | DE.CM-09; ID.IM (low) | CA-7; SI-4 | Alone | **P0** | This is the basis for UNKNOWN/ERROR states (see 05 §E). |
| 24 | Fake or tampered results | Per-device authentication, TLS, signed updates | device credential, TLS pinned/enforced, update signature | ⚠️ shared static API key; HTTP default; unsigned Windows build (`package.json` `"sign": null`) | 8.24; 8.32 Change management (medium) | PR.DS-02 (medium); PR.PS-02 | SC-8; SI-7; SA-10 (low); CM-14 (medium) | Partial | **P0** | Must be designed with the backend. |
| 25 | Malware events | AV detection events | event type, product, threat name, action, time | ⚠️ substring Sigma on System/App logs; Security/Defender operational log not read | 8.7; 8.16 | DE.CM-09; DE.AE-02 (medium) | SI-3; SI-4 | Partial | P1 | W: `Microsoft-Windows-Windows Defender/Operational` IDs 1116/1117 only. |

---

## 2. Coverage by candidate topic

| Topic (from the brief) | Covered today | Verdict |
|---|---|---|
| 1 Asset identity & ownership | Partial | Fix refresh (P0); add join/MDM (P1) |
| 2 OS / patch / restart | Partial, unreliable | Fix false PASS, add reboot + last install (P0) |
| 3 AV/EDR | Windows partial, macOS none, Linux ClamAV only | P0 |
| 4 Firewall | Yes, logic too lenient on Windows | P0 fix |
| 5 Disk encryption | Yes, wrong aggregation + silent osquery failure | P0 fix |
| 6 Local users / privilege | **None** | P0 add |
| 7 Screen lock / auth config | **None** | P0 add (W, M) |
| 8 Secure Boot / TPM / hardening | Windows metadata only | P1 |
| 9 Software inventory / unapproved | Yes (osquery-dependent) | P0 harden; policy server-side |
| 10 Vulnerability / CVE | No | P1, server-side derive |
| 11 Remote access / exposed services | None | P1 |
| 12 Audit configuration | None (logs collected instead) | P1 (config) — replace raw logs |
| 13 Agent health / provenance | Minimal | P0 |

**Answer to "do we collect enough?"** For an MVP endpoint evidence pack, **no — but the gap is small.** Four signals are missing:
- local admins;
- screen lock;
- reboot pending;
- agent/collector health.

Four existing checks also need fixing before their results can be trusted: patch, AV, firewall and encryption. Most other additions are P1. On the other side, the agent collects **more than it needs** in processes, logs, Wi-Fi and peripherals (see 04).

---

## 3. Organisational controls that an agent cannot prove

These need policy, process or other-system evidence. Do not show an agent-derived "compliance %" for them.

| ISO 27001:2022 | Why the endpoint cannot prove it | Where the evidence comes from |
|---|---|---|
| 5.1 Policies for information security; 5.10 Acceptable use | Documents and acknowledgement | GRC / HR |
| 5.9 (ownership part) | Who owns the device | Asset register / HR assignment |
| 5.18 Access rights (review/approval) | Whether admin rights were approved | IAM tickets, access reviews |
| 6.3 Awareness, education and training | Training records | LMS |
| 5.24–5.27 Incident management | Response process | ITSM / SOC |
| 8.8 (process part) | Patch SLAs, risk acceptance | Vulnerability management procedure |
| 8.13 Information backup | Backups usually run off-device | Backup platform |
| 8.32 Change management | Change approval | Change tickets |
| 5.36 Compliance with policies | Periodic review | Internal audit |

The agent's job is to supply **repeatable technical evidence** that these processes are being applied on endpoints, not to replace them.
