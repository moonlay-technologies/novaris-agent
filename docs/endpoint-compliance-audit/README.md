# Endpoint Agent Compliance Audit — Agent Only

Date: 2026-10-16 · Agent version 1.0.4 · Scope: `novaris-agent` (Windows, macOS, Linux). Backend and UI were not reviewed. Static code review only; no changes were made.

## Short answers

1. **What is available?**
   - **All three OSes:** identity (sent once), patch backlog, AV, firewall, disk encryption and software inventory.
   - **Windows only:** TPM and Secure Boot.
   - **Also collected:** ops metrics, processes, logs, peripherals and YARA.
   - **Reliability:** several checks turn collection failures into `false`/`0`. That gives false PASS results (patch, Windows third-party AV, firewall "any profile") and false FAIL results (macOS AV, encryption when osquery is missing).
2. **What is missing?** For an MVP evidence set, four signals:
   - local admin membership;
   - screen-lock policy;
   - reboot pending (Windows);
   - agent/collector health and freshness, with UNKNOWN/ERROR states.

   P1 adds remote access, listening ports, audit configuration, MDM/join state and Secure Boot on macOS/Linux.
3. **Is the grouping right?** No. It is grouped by API endpoint, with patch and software-risk data duplicated and key facts hidden in an untyped `metadata` blob or in free text. Use 10 evidence categories, with verdicts and framework mappings computed server-side.
4. **What can we stop collecting?**
   - processes every 60 s with full Windows command lines;
   - System/Application event-log text;
   - Wi-Fi SSID/BSSID;
   - Bluetooth devices;
   - scheduled YARA scans of user folders;
   - agent-side software-risk keyword lists.

   Move them to on-demand, derive them server-side, or remove them.

## Files

1. [01-current-state.md](01-current-state.md): inventory with file:line evidence
2. [02-compliance-gap-matrix.md](02-compliance-gap-matrix.md): ISO 27001:2022 / CSF 2.0 / SP 800-53 r5 matrix
3. [03-grouping-recommendations.md](03-grouping-recommendations.md): taxonomy and migration
4. [04-data-minimization.md](04-data-minimization.md): KEEP / REDUCE / DERIVE / ON-DEMAND / REMOVE
5. [05-action-plan.md](05-action-plan.md): P0/P1/P2 backlog, tests, open questions
