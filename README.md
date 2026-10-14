# Novaris Agent

Device monitoring agent for the Novaris Asset Management System.

## Features

- Cross-platform support (Windows, macOS, Linux)
- Automatic device registration
- Health metrics collection (CPU, RAM, Disk, Uptime)
- Software inventory collection
- Security posture collection (antivirus, firewall, disk encryption)
- Security event normalization from device logs
- Controlled response action polling with dry-run safety defaults
- Periodic reporting to backend API
- Offline queue with automatic retry
- Configurable collection and reporting intervals

## Installation

### From Source

```bash
npm install
npm run build
npm start
```

### Configuration

### Getting an API Key

1. **Login to the backend** as an admin/superadmin user
2. **Generate an API key** via the API:
   ```bash
   curl -X POST http://localhost:3000/api/v1/api-key/generate \
     -H "Authorization: Bearer YOUR_JWT_TOKEN"
   ```
3. **Set the API key** in your backend environment variable:
   ```bash
   export API_KEY="your-generated-key-here"
   ```
   Or add to `.env` file: `API_KEY=your-generated-key-here`
4. **Restart the backend server**

### Agent Configuration

Configure the agent in the desktop app under **Settings**. Pick the agent mode first:

- **Endpoint** monitors this device only.
- **Network Gateway** also monitors the local network (syslog, SNMP, device discovery, Zeek).
  The *Network monitoring* settings only appear, and only run, in this mode.

Settings are grouped into Connection, Device inventory, Security, Network monitoring,
Remote actions and Application. The YARA malware scan needs the yara-x scanner: use
**Install** on the *Malware scan* card to download it (checksum-verified) into
`plugins/yara/` next to `config.json`.

Settings are stored in `config.json` in the install directory, so headless installs can
still provide one:

```json
{
  "apiUrl": "http://localhost:3000/api/v1",
  "apiKey": "your-api-key-here",
  "assetTag": "ASSET-001",
  "agentMode": "endpoint",
  "reportInterval": 300,
  "softwareInterval": 3600,
  "logsMinSeverity": "warning",
  "responseActionsMode": "acknowledge",
  "logLevel": "info"
}
```

`responseActionsMode` is `off` (don't poll), `acknowledge` (receive actions without
running them) or `execute`. Files written by earlier versions are migrated
automatically on load: `pollResponseActions`, `remoteActionsEnabled` and
`responseActionsDryRun` become `responseActionsMode`, `softwareCollectionInterval`
(report cycles) becomes `softwareInterval` (seconds), and `collectInterval` and
`securityEventsMinSeverity` are dropped.

Environment variables override the file:

- `NOVARIS_API_URL` - Backend API URL
- `NOVARIS_API_KEY` - API key for authentication (get from backend admin)
- `NOVARIS_ASSET_TAG` - Asset tag identifying this device
- `NOVARIS_AGENT_MODE` - `endpoint` or `network_gateway`
- `NOVARIS_REPORT_INTERVAL` - Health reporting interval in seconds (default: 300)
- `NOVARIS_SOFTWARE_INTERVAL` - Software inventory interval in seconds (default: 3600)
- `NOVARIS_COLLECT_SECURITY_POSTURE` - Enable posture collection (true/false)
- `NOVARIS_SECURITY_POSTURE_INTERVAL` - Posture reporting interval in seconds
- `NOVARIS_COLLECT_SECURITY_EVENTS` - Detect security events in collected logs (true/false)
- `NOVARIS_LOGS_MIN_SEVERITY` - Minimum severity for logs and security events (info, warning, error, critical)
- `NOVARIS_RESPONSE_ACTIONS_MODE` - `off`, `acknowledge` or `execute` (default: acknowledge)
- `NOVARIS_RESPONSE_ACTIONS_INTERVAL` - Response action poll interval in seconds
- `NOVARIS_RESPONSE_ACTION_TIMEOUT` - Response action command timeout in seconds
- `NOVARIS_AUTO_START` - Launch the application at login and run in the background (true/false)
- `NOVARIS_LOG_LEVEL` - Log level (error, warn, info, debug)
- `NOVARIS_INSTALL_DIR` - Override the directory holding `config.json` and `logs/`

The deprecated `NOVARIS_POLL_RESPONSE_ACTIONS`, `NOVARIS_REMOTE_ACTIONS_ENABLED` and
`NOVARIS_RESPONSE_ACTIONS_DRY_RUN` are still honoured when
`NOVARIS_RESPONSE_ACTIONS_MODE` is not set.

### Background Operation

A configured device reports on its own, with nobody opening anything. There are
two independent layers, and either is enough:

**Background service (starts at boot).** The platform installers under
`installers/` register the agent to start at boot under the system account, so
the device reports before anyone logs in. See `installers/README.md` for the
mechanism on each platform and how to manage it.

**Desktop application (starts at login).** The application registers itself as
an OS login item and comes back up after a reboot. A login-triggered launch
stays in the system tray: it starts the agent without opening a window and
without raising any dialog, since nobody is waiting on it.

`autoStart` is switched on automatically the first time the agent manages to
start, which is the first time this device is genuinely configured. Whatever
the source of the configuration - an installer, a hand-edited `config.json` or
the desktop UI - the device reports after every login from then on.

Use the *Start automatically in the background at login* checkbox in the
application to turn it off. That choice is recorded as
`autoStartUserManaged: true` and is never overridden afterwards.

**When both are installed**, the application detects the running service and
stays idle rather than starting its own agent, so the backend never receives
two sets of reports for one asset tag. The window shows *Running as a service*
and its Start button is disabled.

Only one copy of the application runs at a time. Launching it while it is
already resident in the tray brings its window forward instead of starting a
second agent.

### AI Assistant

The desktop app includes a local AI assistant (LangChain Deep Agents) that can
read, and with approval change, files in the user's `Documents/AssetAssistant`
folder and search the web. It works as the Novaris user signed in on the
**Account** page: the app loads the assistant policy from `GET /api/v1/me/assistant`
and the runtime calls the backend AI proxy with that user's JWT, so usage is
billed to them and no provider keys are stored on the device. See
[runtime/README.md](runtime/README.md) for how it works.

## Development

```bash
npm run dev
npm run test-runtime     # Python assistant runtime tests (needs uv)
npm run test-electron    # Electron integration tests
```

## Building

```bash
npm run build
npm run dist:full        # builds the assistant runtime bundle, then the installer
```

## Logs

Logs are stored in the `logs/` directory:
- `novaris-agent.log` - Main application log
- `exceptions.log` - Unhandled exceptions
- `rejections.log` - Unhandled promise rejections

