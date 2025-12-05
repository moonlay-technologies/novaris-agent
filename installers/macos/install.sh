#!/bin/bash
# Novaris Agent macOS Installer Script
# Run with sudo

set -e

SERVICE_NAME="com.novaris.agent"
SERVICE_DISPLAY_NAME="Novaris Agent"
INSTALL_DIR="/usr/local/novaris/agent"
CONFIG_FILE="$INSTALL_DIR/config.json"
LAUNCH_DAEMON="/Library/LaunchDaemons/${SERVICE_NAME}.plist"

echo "Installing Novaris Agent..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Create installation directory
echo "Creating installation directory..."
mkdir -p "$INSTALL_DIR"

# Copy files
echo "Copying files..."
cp -R . "$INSTALL_DIR/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/dist/index.js"

# Create config file if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating default configuration..."
    cat > "$CONFIG_FILE" << EOF
{
  "apiUrl": "http://localhost:3000/api/v1",
  "apiKey": "",
  "collectInterval": 300,
  "reportInterval": 300,
  "retryAttempts": 3,
  "retryDelay": 1000,
  "logLevel": "info"
}
EOF
    echo "Please edit $CONFIG_FILE and set your API URL and API Key"
fi

# Create LaunchDaemon plist
echo "Creating LaunchDaemon..."
NODE_PATH=$(which node)
cat > "$LAUNCH_DAEMON" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${SERVICE_NAME}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${NODE_PATH}</string>
        <string>${INSTALL_DIR}/dist/index.js</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${INSTALL_DIR}/logs/novaris-agent.log</string>
    <key>StandardErrorPath</key>
    <string>${INSTALL_DIR}/logs/novaris-agent.error.log</string>
    <key>WorkingDirectory</key>
    <string>${INSTALL_DIR}</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
</dict>
</plist>
EOF

# Set permissions
chown root:wheel "$LAUNCH_DAEMON"
chmod 644 "$LAUNCH_DAEMON"

# Load the service
echo "Loading LaunchDaemon..."
launchctl load -w "$LAUNCH_DAEMON" 2>/dev/null || launchctl load "$LAUNCH_DAEMON"

echo ""
echo "Installation complete!"
echo "Installation directory: $INSTALL_DIR"
echo "Configuration file: $CONFIG_FILE"
echo ""
echo "Next steps:"
echo "1. Edit $CONFIG_FILE and set your API URL and API Key"
echo "2. Start the service: sudo launchctl load -w $LAUNCH_DAEMON"
echo "3. Check status: launchctl list | grep $SERVICE_NAME"

