# Novaris Agent Installers

Installation scripts for Windows, macOS, and Linux.

## Windows Installation

### Using PowerShell Script

1. Open PowerShell as Administrator
2. Navigate to the installer directory
3. Run: `.\install.ps1`

### Manual Installation

1. Copy all agent files to `C:\Program Files\Novaris\Agent`
2. Edit `config.json` and set your API URL and API Key
3. Install as Windows Service using node-windows or manually with `sc.exe`

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

## Service Management

### Windows
- Start: `Start-Service -Name NovarisAgent`
- Stop: `Stop-Service -Name NovarisAgent`
- Status: `Get-Service -Name NovarisAgent`

### macOS
- Start: `sudo launchctl load -w /Library/LaunchDaemons/com.novaris.agent.plist`
- Stop: `sudo launchctl unload /Library/LaunchDaemons/com.novaris.agent.plist`
- Status: `launchctl list | grep com.novaris.agent`

### Linux
- Start: `sudo systemctl start novaris-agent`
- Stop: `sudo systemctl stop novaris-agent`
- Status: `sudo systemctl status novaris-agent`
- Logs: `sudo journalctl -u novaris-agent -f`

