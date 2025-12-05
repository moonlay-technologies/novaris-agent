#!/bin/bash
# Novaris Agent macOS Uninstaller Script
# Run with sudo

set -e

SERVICE_NAME="com.novaris.agent"
INSTALL_DIR="/usr/local/novaris/agent"
LAUNCH_DAEMON="/Library/LaunchDaemons/${SERVICE_NAME}.plist"

echo "Uninstalling Novaris Agent..."

# Check if running as root
if [ "$EUID" -ne 0 ]; then 
    echo "Error: This script must be run as root (use sudo)"
    exit 1
fi

# Unload and remove LaunchDaemon
if [ -f "$LAUNCH_DAEMON" ]; then
    echo "Unloading LaunchDaemon..."
    launchctl unload "$LAUNCH_DAEMON" 2>/dev/null || true
    rm -f "$LAUNCH_DAEMON"
    echo "LaunchDaemon removed"
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

