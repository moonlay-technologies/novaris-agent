#!/bin/bash
# Novaris Agent RedHat/CentOS Uninstaller Script
# Run with sudo

set -e

SERVICE_NAME="novaris-agent"
INSTALL_DIR="/opt/novaris/agent"
SYSTEMD_SERVICE="/etc/systemd/system/${SERVICE_NAME}.service"

echo "Uninstalling Novaris Agent..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Stop and disable service
if systemctl is-active --quiet "$SERVICE_NAME"; then
    echo "Stopping service..."
    systemctl stop "$SERVICE_NAME"
fi

if systemctl is-enabled --quiet "$SERVICE_NAME"; then
    echo "Disabling service..."
    systemctl disable "$SERVICE_NAME"
fi

# Remove systemd service file
if [ -f "$SYSTEMD_SERVICE" ]; then
    echo "Removing systemd service..."
    rm -f "$SYSTEMD_SERVICE"
    systemctl daemon-reload
    echo "Service removed"
fi

# Remove installation directory
if [ -d "$INSTALL_DIR" ]; then
    echo "Removing installation directory..."
    rm -rf "$INSTALL_DIR"
    echo "Installation directory removed"
fi

# Remove parent directory if empty
PARENT_DIR=$(dirname "$INSTALL_DIR")
if [ -d "$PARENT_DIR" ] && [ -z "$(ls -A "$PARENT_DIR")" ]; then
    rm -rf "$PARENT_DIR"
fi

echo ""
echo "Uninstallation complete!"

