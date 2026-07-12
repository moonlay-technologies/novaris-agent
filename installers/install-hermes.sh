#!/usr/bin/env bash
# Install the official Hermes Agent only when the local user does not already have it.
# The upstream script is downloaded to a temporary file before execution rather
# than piping an unchecked response directly into bash.

set -euo pipefail

HERMES_INSTALLER_URL="https://hermes-agent.nousresearch.com/install.sh"

local_user="${SUDO_USER:-${USER:-}}"
local_home="${HOME:-}"

if [ "${EUID:-$(id -u)}" -eq 0 ] && [ -n "${SUDO_USER:-}" ]; then
    if command -v getent >/dev/null 2>&1; then
        local_home="$(getent passwd "$SUDO_USER" | cut -d: -f6)"
    elif command -v dscl >/dev/null 2>&1; then
        local_home="$(dscl . -read "/Users/$SUDO_USER" NFSHomeDirectory | awk '{print $2}')"
    fi
fi

if [ -z "$local_home" ]; then
    local_home="$(eval printf '%s' "~${local_user:+$local_user}")"
fi

local_hermes_home="${HERMES_HOME:-$local_home/.hermes}"

hermes_is_installed() {
    if command -v hermes >/dev/null 2>&1; then
        return 0
    fi

    local home_dir="$local_home"
    local candidates=(
        "$local_hermes_home/hermes-agent"
        "$home_dir/.local/bin/hermes"
        "/usr/local/bin/hermes"
        "/opt/hermes"
    )

    local candidate
    for candidate in "${candidates[@]}"; do
        if [ -x "$candidate" ] || [ -x "$candidate/hermes" ]; then
            return 0
        fi
    done

    return 1
}

if hermes_is_installed; then
    printf '%s\n' 'Hermes is already installed for the local user. Skipping Hermes installation.'
    exit 0
fi

temp_script="$(mktemp "${TMPDIR:-/tmp}/novaris-hermes-install.XXXXXX.sh")"
cleanup() {
    rm -f "$temp_script"
}
trap cleanup EXIT

printf '%s\n' 'Downloading the official Hermes Agent installer...'
curl --fail --silent --show-error --location "$HERMES_INSTALLER_URL" -o "$temp_script"
chmod 700 "$temp_script"
printf '%s\n' 'Running the official Hermes Agent installer...'

if [ "${EUID:-$(id -u)}" -eq 0 ] && [ -n "${SUDO_USER:-}" ] && command -v sudo >/dev/null 2>&1; then
    sudo -u "$SUDO_USER" -H env HOME="$local_home" HERMES_HOME="$local_hermes_home" bash "$temp_script" --skip-setup --non-interactive
else
    HOME="$local_home" HERMES_HOME="$local_hermes_home" bash "$temp_script" --skip-setup --non-interactive
fi
