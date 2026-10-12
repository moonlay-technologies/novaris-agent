# Novaris Agent Installers

Installation scripts for Windows, macOS, and Linux.

## Windows Installation

### Using PowerShell Script

1. Open PowerShell as Administrator
2. Navigate to the installer directory
3. Run: `.\install.ps1`

The installer registers a scheduled task that starts the agent at boot, under
the SYSTEM account, so the device reports without anyone logging in. It also
starts the agent immediately rather than waiting for the next boot.

A Windows service is deliberately not used: the agent is a plain Node process
and never answers the service control manager, so an `sc.exe` service fails to
start with error 1053. Earlier versions registered one, and the installer
removes it if it is still present.

### Manual Installation

1. Copy all agent files to `C:\Program Files\Novaris\Agent`, including `node_modules`
2. Edit `config.json` and set `apiUrl`, `apiKey` and `assetTag`
3. Register a scheduled task running `node "C:\Program Files\Novaris\Agent\dist\index.js"`
   at startup as SYSTEM

### Uninstallation

Run: `.\uninstall.ps1` as Administrator

## macOS Installation

### Using Shell Script

1. Open Terminal
2. Navigate to the installer directory
3. Run: `sudo ./install.sh`

### Manual Installation

1. Copy all agent files to `/usr/local/novaris/agent`
2. Edit `config.json` and set your API URL and API Key
3. Create LaunchDaemon plist in `/Library/LaunchDaemons/com.novaris.agent.plist`
4. Load the service: `sudo launchctl load -w /Library/LaunchDaemons/com.novaris.agent.plist`

### Uninstallation

Run: `sudo ./uninstall.sh`

## Linux Installation

### Debian/Ubuntu

1. Open Terminal
2. Navigate to `installers/linux/debian`
3. Run: `sudo ./install.sh`

### RedHat/CentOS

1. Open Terminal
2. Navigate to `installers/linux/rpm`
3. Run: `sudo ./install.sh`

### Manual Installation

1. Copy all agent files to `/opt/novaris/agent`
2. Edit `config.json` and set your API URL and API Key
3. Create systemd service file in `/etc/systemd/system/novaris-agent.service`
4. Enable and start: `sudo systemctl enable novaris-agent && sudo systemctl start novaris-agent`

### Uninstallation

- Debian/Ubuntu: `sudo ./uninstall.sh` from `installers/linux/debian`
- RedHat/CentOS: `sudo ./uninstall.sh` from `installers/linux/rpm`

## Configuration

After installation, edit the configuration file:

- Windows: `C:\Program Files\Novaris\Agent\config.json`
- macOS: `/usr/local/novaris/agent/config.json`
- Linux: `/opt/novaris/agent/config.json`

Set the following required fields:
- `apiUrl`: Your backend API URL
- `apiKey`: Your API key for authentication
- `assetTag`: The asset tag identifying this device

The agent refuses to start until all three are set.

## Service Management

### Windows
- Start: `Start-ScheduledTask -TaskName NovarisAgent`
- Stop: `Stop-ScheduledTask -TaskName NovarisAgent`
- Restart: `Restart-ScheduledTask -TaskName NovarisAgent`
- Status: `Get-ScheduledTask -TaskName NovarisAgent`
- Logs: `C:\Program Files\Novaris\Agent\logs\novaris-agent.log`

### macOS
- Start: `sudo launchctl load -w /Library/LaunchDaemons/com.novaris.agent.plist`
- Stop: `sudo launchctl unload /Library/LaunchDaemons/com.novaris.agent.plist`
- Status: `launchctl list | grep com.novaris.agent`

### Linux
- Start: `sudo systemctl start novaris-agent`
- Stop: `sudo systemctl stop novaris-agent`
- Status: `sudo systemctl status novaris-agent`
- Logs: `sudo journalctl -u novaris-agent -f`


## Boot Behaviour

All three installers register the agent to start at boot and start it right
away, so a configured device reports without waiting for a login:

| Platform | Mechanism | Runs as |
| --- | --- | --- |
| Windows | Scheduled task, `-AtStartup` | SYSTEM |
| Linux | systemd unit, `WantedBy=multi-user.target` | root |
| macOS | LaunchDaemon, `RunAtLoad` + `KeepAlive` | root |

On Windows the task is also configured to start and keep running on battery,
which the default task settings would otherwise prevent on a laptop.

These installers need Node.js on the machine and the agent's production
dependencies present in the installation directory. Each installer stops with a
clear message when Node.js is missing, and warns when `node_modules` is absent.

## Running Alongside the Desktop Application

The desktop application can be installed on the same machine. It detects a
running background service and stays idle instead of starting its own agent, so
the backend never receives two sets of reports for one asset tag. Its window
shows *Running as a service* in that state.
