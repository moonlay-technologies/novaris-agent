# Novaris Agent Desktop UI/UX Requirements

Status: Design review draft — no implementation approved
Target: Electron desktop application for Windows, macOS, and Linux
Primary design viewport: 1180 × 760px
Minimum viewport: 960 × 640px

## 1. Problem statement

The current renderer is a single centered card designed for a 560 × 860px window. Agent lifecycle, network state, device identity, four Hermes channel forms, pairing, chat, process registry, logs, update controls, and file links are all stacked into one narrow scrolling page. This makes routine state hard to scan, forces advanced settings into the primary workflow, and gives chat and process diagnostics too little usable space.

The redesign must turn Novaris Agent into a normal resizable desktop operations application with persistent navigation, task-focused pages, predictable actions, and progressive disclosure. This phase is design-only: it defines the intended experience and produces mockups for review; it must not modify the current renderer or Electron behavior.

## 2. Users and primary jobs

Primary user: an IT administrator or technical operator responsible for installing, connecting, and monitoring the Novaris endpoint agent.

Primary jobs:

1. Confirm whether the Novaris agent and backend connection are healthy.
2. Start or stop the local agent safely.
3. Confirm which background activities are enabled, running, idle, or failed.
4. Configure the Novaris backend connection and collection behavior.
5. Configure and operate Hermes messaging channels.
6. Use Hermes chat and respond to approval/secret/clarification requests.
7. Inspect diagnostics, logs, version, and available updates.

## 3. UX principles

- Status before settings: everyday health is visible immediately.
- One destination per job: no single-page configuration dump.
- Progressive disclosure: common controls first; advanced intervals and safety controls second.
- Honest data: show only states provided by real runtime contracts.
- Safe operations: stopping the agent, enabling real remote actions, replacing credentials, and installing updates require clear consequences.
- Desktop-native density: efficient but not cramped, keyboard reachable, resizable, and suitable for long-running use.
- Secret-safe by default: stored API keys and channel tokens are never read back into visible fields.

## 4. Application shell

### 4.1 Sidebar

Persistent 224px dark sidebar with:

1. Overview
2. Activities
3. Hermes Chat
4. Channels
5. Settings
6. Diagnostics

The Novaris wordmark appears at the top. App version and update availability appear at the bottom. Each item has a clear icon and text label; the active page uses an emerald-toned selected state. The sidebar must not collapse at the target minimum desktop width.

### 4.2 Top context bar

A 56px top bar remains visible across destinations and shows:

- Device hostname and asset tag, when available.
- Agent state: Running, Stopped, Starting, Stopping, or Error.
- Backend/network state: Online, Offline, Checking, or Not running.
- Optional overflow menu for `Open config file`, `Open logs folder`, and `Quit`.

### 4.3 Window behavior

- Proposed default: 1180 × 760px.
- Proposed minimum: 960 × 640px.
- Resizable and maximizable.
- Closing/minimizing continues to respect the existing tray behavior.
- Page content scrolls independently from sidebar/top bar.

## 5. Information architecture and screen requirements

### 5.1 Overview

Purpose: answer `Is this device working, and what needs attention?`

Required content:

- Page title `Overview` and primary agent lifecycle action (`Start agent` or `Stop agent`).
- Summary status cards for Agent, Backend connection, Hermes Gateway, and Background activities.
- Device card showing hostname, platform, asset tag, and device ID when available.
- Recent activity summary derived from process registry: failed activity count, last completed activity, and a link to Activities.
- Configuration attention banner when required fields (`apiUrl`, `apiKey`, `assetTag`) are missing.
- Update banner only when an update is actually available or update checking failed.

Current-contract mapping:

- Agent/network: `getAgentStatus()` and `onAgentStatusChanged()`.
- Device: `getSystemInfo()` plus `getConfig()`.
- Gateway: `hermesGatewayStatus()`.
- Activities: `getProcessRegistry()`.
- Update: `getAppVersion()` and `checkForUpdate()`.

Do not show fake charts or health metrics in the first redesign. CPU/RAM/disk are collected internally but are not exposed by the current preload contract.

### 5.2 Activities

Purpose: inspect and control background Novaris operations.

Required content:

- Grouped table/sections for Lifecycle, Collection, Reporting, and Integration.
- Columns: Process, State, Interval, Runs, Last run, Configuration.
- Filters: All, Running, Failed, Disabled.
- Search by process name.
- Explicit status labels for idle, running, failed, and disabled.
- Toggle only where an existing config key supports it.
- A change that requires restart must explain the restart consequence and show save/restart progress.
- Failed rows show a concise inline error and `View logs` action.
- Refresh action and generated-at timestamp.

Existing supported toggles:

- Patch status reporting
- Security posture reporting
- Operating system log reporting
- Process reporting
- Response action polling

### 5.3 Hermes Chat

Purpose: provide a full-size local Hermes conversation workspace.

Required content:

- Connection state in the page header.
- Compact connection setup for gateway port and optional protected-loopback session token.
- Connect/disconnect action separated from message send.
- Scrollable conversation timeline using distinct operator and Hermes messages.
- Docked multiline composer with send action and keyboard guidance.
- Inline cards for approval, secret, sudo, and clarification requests.
- Secrets use password input and disappear after submission.
- Connection failures remain visible and include a path to Channels or Diagnostics.
- Empty state explains that the Hermes Gateway must be started first.

The mockup may show realistic sample conversation content, but it must be labeled as design sample data and must not imply a live connected session.

### 5.4 Channels

Purpose: configure Hermes messaging integrations without exposing every credential field simultaneously.

Required content:

- Overview cards for Telegram, Discord, Slack, and WhatsApp.
- Each card shows Enabled/Disabled, Configured/Not configured, and runtime availability when provided.
- Each card has one `Configure` action.
- Configuration opens a dedicated detail page or right-side sheet.
- Token/API key values are blank after save; use `Configured` markers rather than fake masked values.
- Telegram: bot token, optional home channel, pairing approvals.
- Discord: bot token, optional home channel.
- Slack: app token and bot/API key.
- WhatsApp: enablement and pairing guidance.
- Gateway controls (Start, Stop, Restart, Refresh) appear once at page level, not repeated per channel.
- Pending pairings and approved users should be separate sections when supported by `hermesPairingPending()` and `hermesPairingList()`.
- Revocation requires confirmation.

### 5.5 Settings

Purpose: edit Novaris configuration in understandable groups.

Use horizontal tabs or section navigation inside the page:

#### Connection

- Backend API URL
- API key (write-only secret)
- Asset tag
- Read-only device ID and hostname when assigned
- `Test connection` is a future enhancement unless a real IPC contract is added; mockups must not present it as currently functional.

#### Collection

- Base collection and reporting intervals
- Software inventory and interval
- Connected devices
- Network neighbors
- Patch status and interval
- Security posture and interval
- Operating-system logs, interval, batch size, minimum severity, include raw
- Security events and minimum severity
- Process collection and interval

#### Response actions

- Poll response actions and interval
- Command timeout
- Remote actions enabled
- Dry-run mode

Enabling real remote actions while dry-run is off is high risk and requires an explicit confirmation explaining that remote commands may execute on the endpoint.

#### Application

- Auto-start at system login
- Log level
- Log file path where editable
- Retry attempts and retry delay

Settings behavior:

- Dirty state is visible.
- `Discard` and `Save changes` remain available in a sticky footer.
- Inline validation prevents invalid ports, intervals, URLs, and enum values.
- Save feedback states whether the agent must restart.
- Advanced fields are collapsed by default for ordinary operators.

### 5.6 Diagnostics

Purpose: consolidate troubleshooting, logs, updates, and application identity.

Required tabs/sections:

#### Logs

- Recent agent logs using `getAgentLogs()`.
- Search, severity filter when parsable, line count selector, refresh, copy, and `Open logs folder`.
- Monospaced selectable output and empty/error states.

#### Updates

- Current version, last check result, latest version, release notes when available, check action, and download/install action.
- Download progress is determinate when percent is available.
- Explain that an external installer may open.

#### About

- Novaris Agent product name and version.
- Host platform/architecture when supplied.
- Links to config and logs locations.
- No decorative legal or support links unless real targets exist.

## 6. First-run and degraded states

### First-run configuration

When required Novaris settings are missing, the app should open to a focused setup state rather than silently presenting a generic stopped agent. The setup contains Backend API URL, API key, and Asset Tag. Saving should validate locally and then return to Overview. This may require implementation work beyond the design phase.

### Offline backend

- Agent may be running while backend is offline.
- Preserve both states; do not simplify them into one red `Stopped` state.
- Explain that reports may queue for retry only if confirmed by runtime data; otherwise say `Backend unavailable` without claiming queue state.

### Hermes unavailable

- Distinguish Hermes not installed, gateway stopped, gateway misconfigured, and gateway connection failed when the corresponding runtime service provides those states.
- Offer the next valid action, not a terminal command dump.

### Activity failure

- Show failed count on Overview.
- Preserve the specific process error in Activities.
- Link to filtered logs in Diagnostics.

## 7. Interaction and feedback requirements

- Every asynchronous action has idle, pending, success, and failure treatment.
- Disable only the action in progress unless the whole page truly depends on it.
- Routine success uses a short toast; persistent errors use an inline banner.
- Avoid JavaScript alert dialogs in the redesigned experience.
- Dangerous confirmations default focus to Cancel.
- Escape closes non-destructive dialogs/sheets; unsaved changes require confirmation.
- Enter submits short forms; Ctrl/Cmd+Enter sends multiline chat.
- Status polling should update values without stealing focus or moving controls.

## 8. Accessibility requirements

- Meet WCAG 2.1 AA contrast for text and controls.
- Fully keyboard navigable with visible focus.
- One `h1` per page and logical heading order.
- Status never uses color alone; pair icon and text.
- Inputs have persistent labels, not placeholder-only labels.
- Tables provide headers and accessible names for row actions.
- Live status messages use polite announcement; critical failures use assertive announcement sparingly.
- Minimum prominent-action hit target: 44 × 44px. Compact table actions may be 36px with adequate spacing.
- Motion respects reduced-motion settings.

## 9. Data and IPC boundaries

The design should reuse the existing preload surface:

- Agent: start, stop, status, status events
- Processes: registry, activity configuration, logs
- Configuration: get/save config
- System: device information
- Application: version, update check/install/progress
- Files: open config and logs
- Hermes: bootstrap, gateway config/lifecycle, pairing, chat/session/events

Mockups can define improved organization around these operations. They must not suggest implementation of unsupported features such as historical metrics charts, backend fleet data, process execution on demand, or connection tests unless future IPC requirements are clearly labeled.

## 10. Security requirements

- Treat API keys, channel tokens, session tokens, sudo passwords, and secret responses as sensitive.
- Never display a persisted secret retrieved from storage.
- Clear secret fields after save or submit.
- Do not include credentials in logs, error copy, screenshots, or clipboard actions.
- Require confirmation for token replacement, pairing revocation, real remote actions, agent stop, and app update/install where interruption is possible.
- Preserve Electron context isolation and the narrow preload bridge in any future implementation.

## 11. Design review screen set

Google Stitch should draft these desktop screens in one consistent project:

1. Overview — healthy running state with one update available.
2. Activities — grouped process table with one failed reporting activity.
3. Hermes Chat — connected conversation with an approval request card.
4. Channels — gateway running, Telegram configured, others mixed states.
5. Settings / Connection — dirty form state with write-only API key treatment.
6. Diagnostics / Logs — searchable log viewer with a warning and an error.

Use realistic but clearly sample values such as `WS-ARDY-014`, `AST-01428`, `Online`, and `Last report 2 min ago`. Never use real credentials.

## 12. Out of scope for this phase

- Changing `src-electron/ui/index.html`.
- Changing BrowserWindow dimensions or behavior.
- Adding a frontend framework.
- Adding or changing IPC handlers.
- Persisting new settings.
- Implementing the generated Stitch markup.
- Building, packaging, or deploying the redesigned application.

## 13. Review acceptance criteria

The design is ready for implementation planning only after the reviewer confirms:

- The six-destination information architecture is appropriate.
- Overview prioritizes the right status and actions.
- Activities and Hermes are separated cleanly from Settings.
- Credential and remote-action safety treatments are acceptable.
- Density is suitable for a normal desktop window.
- The selected Novaris evergreen/charcoal visual direction is approved.
- Stitch screens demonstrate consistent shell, typography, states, and component behavior.
