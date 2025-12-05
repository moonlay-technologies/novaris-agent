#!/bin/bash
# Novaris Agent RedHat/CentOS Installer Script
# Run with sudo

set -e

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

# Create systemd service
echo "Creating systemd service..."
NODE_PATH=$(which node)
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

# Reload systemd and enable service
echo "Enabling service..."
systemctl daemon-reload
systemctl enable "$SERVICE_NAME"

echo ""
echo "Installation complete!"
echo "Installation directory: $INSTALL_DIR"
echo "Configuration file: $CONFIG_FILE"
echo ""
echo "Next steps:"
echo "1. Edit $CONFIG_FILE and set your API URL and API Key"
echo "2. Start the service: sudo systemctl start $SERVICE_NAME"
echo "3. Check status: sudo systemctl status $SERVICE_NAME"

