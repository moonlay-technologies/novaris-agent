# 04 — Data Minimisation Review

The default rule is to collect configuration **state**, not user content or behaviour. "Inventory for asset management" and "evidence strictly needed for compliance" are marked separately, so the product owner can keep the first knowingly rather than by accident.

**No measurements were taken.** All volume figures are **estimates** from code limits and typical device sizes, and are labelled as such.

## 1. Accidental-capture check (from the brief)

| Concern | Captured today? | Where | Verdict |
|---|---|---|---|
| Browser history, URLs, keystrokes, screenshots, clipboard, messages | **No** direct collector | — | ✅ OK. URLs can appear indirectly in process command lines and event-log messages. |
| Documents / file contents | **Partially**: YARA reads file bytes locally; only rule name + **file path** are sent | `yaraScanCollector.ts:18-29`, `agentService.ts:383-395` | File paths in Downloads/Desktop reveal personal file names → ON-DEMAND |
| Passwords, tokens, keys | **Possible** via Windows process command lines (`--password=`, `-token`, connection strings) and event-log messages. Redaction covers only `Bearer`, `api_key=`, `password=`. | `processes.js:909`, `reportingService.ts:609`, `logCollector.ts:47-52` | ❌ **Highest-priority privacy fix** |
| BitLocker recovery keys | **No**: only `drive_letter, protection_status, encryption_method` | `securityPostureCollector.ts:171-173` | ✅ Keep it that way; add a test that asserts the column list |
| Full command lines | **Yes** (Windows), every 60 s | `processCollector.ts:135` | REMOVE from scheduled collection |
| Raw process list | **Yes**, every 60 s | `config.ts:102-103` | ON-DEMAND |
| Precise location | **Indirect**: Wi-Fi **BSSID** can be geolocated through public databases | `connectedDevicesCollector.ts:270-276` | REMOVE |
| Home Wi-Fi names | **Yes**: SSID | same | REMOVE |
| Personal device identities | **Yes**: Bluetooth MACs/names of phones and headsets, USB serials | `connectedDevicesCollector.ts:107-142`, `:44-105` | REDUCE |
| Full event logs / raw audit events | **Partially**: all System + Application warnings/errors (message text), every 5 min; `raw` off by default | `logCollector.ts:97-103`, `config.ts:100` | REDUCE → audit *configuration* + a narrow event-ID allowlist |
| Logged-in user identity | Collected, not sent | `deviceInfoCollector.ts:49` | UNKNOWN (policy decision) |

## 2. Field-by-field decisions

| Field / collector | Decision | Reason | Minimal replacement |
|---|---|---|---|
| hostname, serial, OS family/version | **KEEP** | Identity (ISO 5.9 / CM-8) | + build, edition, model |
| IP / MAC (first interface) | **KEEP WITH REDUCED DETAIL** | Asset correlation; the first-interface pick is unreliable | primary MAC of the default-route interface; drop IP or keep it as "last seen" only |
| currentUser | **UNKNOWN** | Useful for ownership (5.9), but personal data. Currently wrong in service mode. | If kept: the console user's account name only, never a history of logons |
| agentVersion | **KEEP** | Evidence provenance | — |
| cpu/ram/disk usage samples | **KEEP (ops), not compliance** | Asset/ops value; no control needs them | Lower cadence (15 min) or on-demand; send disk *free %* of the system volume only |
| uptime | **KEEP** | Supports reboot/patch evidence | — |
| software name/version/date | **KEEP** | 8.19, 8.8, CM-8/CM-11 | + publisher. Send a **delta or hash** when unchanged. |
| software hacked/licence indicators | **DERIVE** | Server-side, versioned rules against the inventory; agent keyword lists are low precision and hard to update | Remove from the agent |
| patch counts | **KEEP** | 8.8 / SI-2 | + reboot_pending, last_install_at, status |
| patch sample titles (≤5 W, ≤20 L/M) | **ON-DEMAND** | Not needed for a pass/fail rule | Fetch only when investigating |
| AV/firewall/encryption facts | **KEEP** | Core P0 evidence | Typed; per-profile/system volume |
| SecurityCenter raw objects incl. `pathToSignedProductExe` | **KEEP WITH REDUCED DETAIL** | Product name + state is enough | `{name, enabled, up_to_date}` |
| TPM / Secure Boot | **KEEP** | Hardening evidence | Typed |
| Duplicated patch / risk fields on posture | **REMOVE** | Duplicates | — |
| Event logs (System+Application ≥ warning) | **REDUCE → ON-DEMAND** | Compliance needs audit **configuration**. Full message text holds user names, paths and hostnames. | Scheduled: audit-policy state. Optional stream: allowlisted event IDs only (e.g. Defender 1116/1117, Windows Update failures, Security 4625 count per hour as an aggregate) with **no free-text message** |
| Sigma security events from logs | **KEEP (optional stream)** | Detection, not compliance | Feed them from the narrowed sources above |
| Processes (name, pid, cpu, ram, command) every 60 s | **REMOVE from schedule → ON-DEMAND** | No compliance control needs a minute-by-minute process list. It is the most sensitive and highest-volume stream. | Available through the existing `collect_diagnostics` response action; never send `command` by default |
| Listening ports | (new) **KEEP, aggregated** | Exposure (8.20 / CM-7) | proto, port, process name; no remote peers |
| USB / printers / displays inventory | **KEEP WITH REDUCED DETAIL (asset mgmt)** | Asset value only | kind, vendor, model; drop serials unless asset policy needs them; cadence ≥ 1 h |
| Bluetooth devices | **REMOVE** (or UNKNOWN if asset mgmt needs it) | Mostly personal devices | — |
| Wi-Fi SSID, BSSID, channel, signal | **REMOVE** | Location + personal network | If needed: `wifi_security` type only (open/WPA2/WPA3) |
| ARP neighbours (off by default) | **REMOVE** from endpoint mode | Network monitoring, not endpoint compliance | Gateway mode only |
| YARA scheduled scan of Downloads/Desktop | **ON-DEMAND** | Duplicates the AV control (8.7). Sends personal file paths. Broken in service mode. | Keep as the existing `scan_path` response action |
| Gateway features (syslog, SNMP, discovery, Zeek) | **OUT OF SCOPE** | Off in endpoint mode | — |

## 3. Prohibited collection (put in code review checklist + tests)

The agent must never collect or transmit:
- passwords, password hashes, tokens, API keys, private keys or certificates' private parts;
- BitLocker/FileVault/LUKS recovery keys or key protectors' secret material;
- file contents, clipboard, screenshots, keystrokes, browser history/URLs, message content;
- full command lines by default;
- Wi-Fi SSID/BSSID or geolocation;
- raw Security event log content.

Suggested guard: a unit test per collector that asserts the exact output key set (an allowlist), plus a payload scrubber in `reportingService` that drops unknown keys.

## 4. Retention recommendations (for the backend team)

| Data | Suggested retention | Rationale |
|---|---|---|
| Latest evidence per category per device | while the device is active | Current posture |
| Evidence history (daily snapshot of rule results, not raw payloads) | 12–13 months | Covers a typical annual ISO surveillance audit cycle (**assumption**; confirm with GRC) |
| Raw category payloads | 30–90 days | Troubleshooting |
| Event streams (security events) | 90 days | Incident lookback |
| On-demand diagnostics (processes, YARA) | 30 days or case closure | Investigation only |
| Device record after retirement | per asset-disposal policy | ISO 7.14 / 5.11 (process) |

## 5. Expected improvements (estimates, not measurements)

| Change | Current (estimate) | After | Basis |
|---|---|---|---|
| Processes 60 s → on-demand | ~150–300 processes × ~200–2,000 B × 1,440/day ≈ **40–600 MB/day/device uncompressed** (upper bound driven by Windows command lines capped at 2,000 chars) | ≈ 0 | `config.ts:103`, `reportingService.ts:605-609` |
| Event logs 5 min → config + allowlisted IDs | ≤200 msgs × 288/day; typical device far fewer, say 1–20 MB/day | < 100 KB/day | `logCollector.ts:94`, `config.ts:97-98` |
| Software full list hourly → hash/delta | 300–2,000 items × ~100 B × 24 ≈ 1–5 MB/day | ~KBs unless changed | `config.ts:89` |
| Peripherals 5 min → 1 h | small, but 288 bulk syncs/day | 24/day | `agentService.ts:646-648` |
| CPU cost | 1,440 `si.processes()` runs/day (expensive on Windows: WMI); 288 PowerShell `Get-WinEvent` runs | removed | — |

Validate these numbers with one week of payload logging on 2–3 test machines (Windows, macOS, Linux) before quoting them.
