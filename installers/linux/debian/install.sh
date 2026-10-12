#!/bin/bash
# Novaris Agent Debian/Ubuntu Installer Script
# Run with sudo

set -e

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"

SERVICE_NAME="novaris-agent"
SERVICE_DISPLAY_NAME="Novaris Device Monitoring Agent"
INSTALL_DIR="/opt/novaris/agent"
CONFIG_FILE="$INSTALL_DIR/config.json"
SYSTEMD_SERVICE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Installing Novaris Agent..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Node runs the agent, so it has to be present before anything is registered
NODE_PATH=$(command -v node || true)
if [ -z "$NODE_PATH" ]; then
    echo "Error: Node.js was not found. Install Node.js and run this script again."
    exit 1
fi
echo "Using Node.js at $NODE_PATH"

"$SCRIPT_DIR/../../install-hermes.sh"

# Create installation directory. The log directory has to exist up front:
# systemd fails a unit outright when an append: target directory is missing.
echo "Creating installation directory..."
mkdir -p "$INSTALL_DIR"
mkdir -p "$INSTALL_DIR/logs"

# Copy files
echo "Copying files..."
cp -R . "$INSTALL_DIR/" 2>/dev/null || true
chmod +x "$INSTALL_DIR/dist/index.js"

# A unit pointing at a missing script would fail at every boot
if [ ! -f "$INSTALL_DIR/dist/index.js" ]; then
    echo "Error: $INSTALL_DIR/dist/index.js is missing. Run this script from a build that contains dist/index.js."
    exit 1
fi

if [ ! -d "$INSTALL_DIR/node_modules" ]; then
    echo "Warning: node_modules is missing from $INSTALL_DIR. The agent cannot start without its dependencies."
fi

# Create config file if it doesn't exist
if [ ! -f "$CONFIG_FILE" ]; then
    echo "Creating default configuration..."
    cat > "$CONFIG_FILE" << EOF
{
  "apiUrl": "http://localhost:3000/api/v1",
  "apiKey": "",
  "assetTag": "",
  "collectInterval": 300,
  "reportInterval": 300,
  "retryAttempts": 3,
  "retryDelay": 1000,
  "logLevel": "info"
}
EOF
    echo "Please edit $CONFIG_FILE and set apiUrl, apiKey and assetTag"
fi

# Create systemd service
echo "Creating systemd service..."
cat > "$SYSTEMD_SERVICE" << EOF
[Unit]
Description=${SERVICE_DISPLAY_NAME}
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_PATH} ${INSTALL_DIR}/dist/index.js
Restart=always
RestartSec=10
StandardOutput=append:${INSTALL_DIR}/logs/novaris-agent.log
StandardError=append:${INSTALL_DIR}/logs/novaris-agent.error.log

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd, enable at boot and start now
echo "Enabling service..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo "Starting service..."
systemctl restart "$SERVICE_NAME" || echo "Warning: the agent could not start yet. Check: systemctl status $SERVICE_NAME"

echo ""
echo "Installation complete!"
echo "Installation directory: $INSTALL_DIR"
echo "Configuration file: $CONFIG_FILE"
echo ""
echo "The agent runs in the background and starts automatically at boot."
echo ""
echo "Next steps:"
echo "1. Edit $CONFIG_FILE and set apiUrl, apiKey and assetTag"
echo "2. Restart the service: sudo systemctl restart $SERVICE_NAME"
echo "3. Check status: sudo systemctl status $SERVICE_NAME"
