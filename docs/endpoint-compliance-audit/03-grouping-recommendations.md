# 03 — Grouping Recommendations

Scope: the agent's payload structure only. Backend tables and UI groups were not reviewed, so the **impact on them is listed as work to confirm**, not as a known state.

## 1. Critique of the current grouping

The agent groups data **by API endpoint and collector**, not by security domain (see [01 §4](01-current-state.md#4-current-grouping-agent-side)). Problems:

| # | Problem | Evidence |
|---|---|---|
| G1 | **Patch data lives in two places.** It goes to `/patch-status` and is copied into `/security-posture` (`patch_missing_critical`, `patch_pending_updates`, `patch_last_checked_at`). The copy can be up to 6 h older than the source. | `agentService.ts:776-780`, `reportingService.ts:413-415` |
| G2 | **Software-risk results live in three places:** as free text appended to patch `details`, as counts on posture, and as samples in posture `metadata`. Software risk has nothing to do with patching. | `agentService.ts:695-697`, `:782-797` |
| G3 | **Typed vs untyped split is arbitrary.** AV/firewall/encryption are typed columns, but Defender real-time, tamper protection, signature age, TPM and Secure Boot are hidden in an untyped `metadata` blob, together with raw SecurityCenter objects. | `securityPostureCollector.ts:150-160` |
| G4 | **Evidence and verdict are mixed.** `antivirusUpToDate` (a judgement with a hard-coded 7-day threshold) and `missingCritical` (a heuristic) are computed on the agent. The raw fact (`signature_age_days`, `pending_security`) is either missing or untyped. | `securityPostureCollector.ts:81`, `patchStatusCollector.ts:103` |
| G5 | **Structured facts are buried in free text.** `reboot_required`, `package_manager` and `security_updates_detected` exist only inside the `details` string. | `patchStatusCollector.ts:206-214` |
| G6 | **Compliance evidence and ops telemetry share an endpoint.** `/health` carries CPU/RAM (ops) together with agent version (evidence health) and triggers software + peripheral sync. | `reportingService.ts:266-296` |
| G7 | **Identity is a one-shot registration**, not a refreshable evidence group. | `reportingService.ts:208-217`, `agentService.ts:650-652` |
| G8 | **No cross-OS normalisation.** `firewallProfile` holds Windows profile names, `"ufw"`, `"firewalld"` or `null` in the same field. `diskEncryptionMethod` mixes `"FileVault"`, `"LUKS"` and BitLocker enum numbers. | `securityPostureCollector.ts:143`, `:203`, `:226`, `:180` |
| G9 | **No per-check status.** A group either exists or does not. One failing sub-check (e.g. BitLocker) silently turns into `false` for that field. | `securityPostureCollector.ts:18-32` |

Naming inconsistencies:
- `softwareInterval` vs the legacy `softwareCollectionInterval` (`utils/config.ts:82-128`);
- `collectedAt` vs `lastCheckedAt` vs `checked_at` for the same idea;
- `os` (patch) vs `osVersion` (device);
- `missingCritical` actually means "security **or** critical category present".

## 2. Design rule: keep three layers separate

```
Evidence category (what is collected, on the agent)
      │  one fact, collected once
      ▼
Policy rule (how it is evaluated, server-side, versioned, thresholds configurable)
      │  one rule can use many facts
      ▼
Framework mapping (why it matters: ISO 27001 A.x / CSF 2.0 / 800-53, many-to-many)
```

- The agent should send **facts plus collection status**, not verdicts. For example, send `signature_age_days: 3`, not `up_to_date: true`.
- Framework mappings belong in a backend table such as `rule_id → [control refs]`. They must **never** shape the agent payload, so adding SOC 2 or CIS later costs no new collection.

## 3. Proposed evidence categories

The brief's candidate list is mostly right. Changes are noted in the last column.

| # | Category (id) | Boundary: what goes here | Not here | vs candidate |
|---|---|---|---|---|
| 1 | **Device & Asset Identity** (`identity`) | serial, hostname, model, OS family/version/build/edition/arch, primary IP/MAC, join/MDM state, agent-reported asset tag | users, software | same |
| 2 | **OS & Patch Health** (`patch`) | pending total/security, last successful scan, last install, reboot pending, uptime | software versions | same |
| 3 | **Endpoint Protection** (`protection`) | AV/EDR products, real-time, signature age, tamper protection; macOS Gatekeeper/XProtect | firewall | same |
| 4 | **Encryption & Data Protection** (`encryption`) | system-volume encryption, method, protection status; USB-storage policy (P2) | recovery keys (never) | same |
| 5 | **Identity, Access & Session** (`access`) | local admin members, guest/built-in admin state, screen lock, local password/lockout policy | domain user directory | **renamed**: absorbs screen lock/session, which the candidate list left without a home |
| 6 | **Network Exposure & Remote Access** (`exposure`) | host firewall per profile, RDP/SSH/Screen Sharing, listening-port summary | Wi-Fi names, ARP neighbours | **renamed** to make clear it is about the device's exposure, not network monitoring |
| 7 | **Software Inventory** (`software`) | name, version, publisher, scope | vulnerability verdicts (derived), licence heuristics | **split**: "Vulnerabilities" moves to the rule layer because it is derived server-side |
| 8 | **Hardening & Boot Integrity** (`hardening`) | Secure Boot, TPM, SIP, small baseline set (SMBv1, AutoRun…) | firewall, encryption | same, plus boot integrity |
| 9 | **Audit & Logging Configuration** (`audit`) | audit policy, log service state, log size, time sync | raw event content | **narrowed**: configuration only; events go to an optional stream |
| 10 | **Agent & Evidence Health** (`agent`) | agent version, run mode, elevation, osquery availability, per-collector status/last success/error, config hash | — | same |
| — | *Operational telemetry* (not compliance) | CPU/RAM/disk/uptime samples, peripherals inventory | — | **explicitly outside** the compliance taxonomy so it is not mistaken for evidence |
| — | *Security event streams* (optional, on-demand) | AV detections, YARA matches, Sigma hits, processes | — | **separate** stream with its own retention |

Every category payload should carry the same envelope (see [05](05-action-plan.md) item A1):

```json
{ "category": "encryption", "schema_version": 1, "collected_at": "...", "agent_version": "1.0.4",
  "platform": "windows", "run_mode": "service", "elevated": true,
  "checks": { "system_volume": { "status": "ok|unknown|error|not_applicable", "source": "osquery:bitlocker_info", "error": null,
                                  "value": { "encrypted": true, "method": "XTS-AES-128", "protection_on": true } } } }
```

## 4. Old → new field mapping (all current agent fields)

| Current field (payload) | New category.check | Action |
|---|---|---|
| hostname, serial_number, os_type, os_version, ip_address, mac_address (`/devices/register`) | identity.* | Keep; **re-send on change**; add build/edition/model |
| currentUser (collected, unsent) | identity.primary_user? | UNKNOWN; needs a policy decision (see 04) |
| agent_version (`/health`) | agent.agent_version | Move |
| cpu_usage, cpu_cores, ram_usage, disk_usage (`/health`) | ops telemetry | Keep outside compliance |
| uptime (`/health`) | patch.uptime_days | Reuse as evidence |
| software_list (`/software/sync`) | software.items | Keep; add publisher |
| software_hacked_indicators_*, missing_license_* (posture + patch details) | rule layer (server-side) | Stop sending from the agent; derive server-side |
| os, pending_updates, missing_critical, last_checked_at (`/patch-status`) | patch.pending_total, pending_security, scan.collected_at | Keep; rename; add status |
| details (`/patch-status` free text) | patch.reboot_pending, patch.source, (sample titles on-demand) | Split into typed fields |
| patch_* copies in `/security-posture` | — | **Remove** duplicate |
| antivirus_installed/enabled/up_to_date/product_name | protection.products[], realtime, signature_age_days | Facts instead of verdicts |
| metadata.defender_realtime/tamper/signature_age_days | protection.* | Promote to typed |
| metadata.security_center_antivirus_products (raw objects) | protection.products[] {name, state} | Reduce (drop exe path) |
| firewall_enabled, firewall_profile | exposure.firewall {per_profile, product} | Change aggregation |
| disk_encryption_enabled/method/volumes | encryption.system_volume, encryption.other_volumes_count | Change aggregation |
| metadata.tpm_present/ready, secure_boot_enabled | hardening.* | Promote to typed; add M/L |
| `/logs` items | event stream (optional) | Reduce (see 04) |
| `/security-events` | event stream | Keep, narrowed sources |
| `/processes` | on-demand only | Remove scheduled |
| `/connected-devices/sync` | ops/asset inventory | Reduce |
| YARA matches | event stream, on-demand | On-demand |

## 5. Compatibility and migration impact

| Area | Impact | Mitigation |
|---|---|---|
| Agent ↔ API contract | New category payloads, removed duplicates | Add a versioned endpoint (e.g. `POST /devices/:id/evidence` with `schema_version`) and **keep the old endpoints** for one release. Send both while `evidenceV2` is enabled. |
| Backend DB | New tables/columns per category + per-check status (**not reviewed**) | Confirm with the backend team; JSONB per category + typed rule outputs is the lowest-cost option. |
| Rules | Verdicts move from agent to server | Port the 7-day signature rule, "missing critical" etc. into versioned server rules *before* the agent stops sending them. |
| UI | Groups change from "Health / Patch / Security posture" to 10 categories (**not reviewed**) | Map old tabs to the new categories; show `UNKNOWN` distinctly from `FAIL`. |
| Old agents in the field | Keep sending the old shape | Server treats missing categories as `UNKNOWN`, never `PASS`. |
