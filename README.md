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

Create a `config.json` file in the agent directory:

```json
{
  "apiUrl": "http://localhost:3000/api/v1",
  "apiKey": "your-api-key-here",
  "assetTag": "ASSET-001",
  "collectInterval": 300,
  "reportInterval": 300,
  "retryAttempts": 3,
  "retryDelay": 1000,
  "collectSecurityPosture": true,
  "securityPostureInterval": 21600,
  "collectSecurityEvents": true,
  "securityEventsMinSeverity": "warning",
  "pollResponseActions": true,
  "responseActionsInterval": 60,
  "responseActionTimeout": 30,
  "remoteActionsEnabled": false,
  "responseActionsDryRun": true,
  "logLevel": "info",
  "autoStart": true
}
```

### Background Operation

The desktop application registers itself as an OS login item and comes back up
on its own after a reboot. A login-triggered launch stays in the system tray:
it starts the agent without opening a window and without raising any dialog.

`autoStart` is switched on automatically the first time the agent manages to
start, which is the first time this device is genuinely configured. Whatever
the source of the configuration - the installer, a hand-edited `config.json`
or the desktop UI - the device begins reporting after every login from then on.

Use the *Start automatically in the background at login* checkbox in the
application to turn it off. That choice is recorded as
`autoStartUserManaged: true` and is never overridden afterwards.

Only one instance runs at a time. Launching the application while it is already
resident in the tray brings its window forward instead of starting a second
agent.

Or use environment variables:

- `NOVARIS_API_URL` - Backend API URL
- `NOVARIS_API_KEY` - API key for authentication (get from backend admin)
- `NOVARIS_COLLECT_INTERVAL` - Collection interval in seconds (default: 300)
- `NOVARIS_REPORT_INTERVAL` - Reporting interval in seconds (default: 300)
- `NOVARIS_COLLECT_SECURITY_POSTURE` - Enable posture collection (true/false)
- `NOVARIS_SECURITY_POSTURE_INTERVAL` - Posture reporting interval in seconds
- `NOVARIS_COLLECT_SECURITY_EVENTS` - Enable normalized security events (true/false)
- `NOVARIS_SECURITY_EVENTS_MIN_SEVERITY` - Minimum event severity (info, warning, error, critical)
- `NOVARIS_POLL_RESPONSE_ACTIONS` - Poll pending response actions (true/false)
- `NOVARIS_RESPONSE_ACTIONS_INTERVAL` - Response action poll interval in seconds
- `NOVARIS_RESPONSE_ACTION_TIMEOUT` - Response action command timeout in seconds
- `NOVARIS_REMOTE_ACTIONS_ENABLED` - Enable real endpoint actions (defaults to false)
- `NOVARIS_RESPONSE_ACTIONS_DRY_RUN` - Acknowledge actions without execution when true
- `NOVARIS_AUTO_START` - Launch the application at login and run in the background (true/false)
- `NOVARIS_LOG_LEVEL` - Log level (error, warn, info, debug)

## Development

```bash
npm run dev
```

## Building

```bash
npm run build
```

## Logs

Logs are stored in the `logs/` directory:
- `novaris-agent.log` - Main application log
- `exceptions.log` - Unhandled exceptions
- `rejections.log` - Unhandled promise rejections

