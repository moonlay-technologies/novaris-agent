import { app } from 'electron';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../../dist/utils/logger';

/**
 * Command line flag the OS login item passes back to us. An instance started
 * with it knows the system launched it, not a person, and must stay in the
 * tray without opening a window or a modal dialog.
 */
export const BACKGROUND_LAUNCH_FLAG = '--hidden';

const LINUX_AUTOSTART_ENTRY = 'novaris-agent.desktop';

/**
 * Registers and unregisters the application as an OS login item so the agent
 * comes back up on its own after a reboot.
 *
 * Electron implements setLoginItemSettings on Windows and macOS only, so Linux
 * falls back to a freedesktop autostart entry.
 */
export class AutoStartService {
  // Resolved lazily: this service may be constructed before the logger exists.
  private get logger() {
    return getLogger();
  }

  /**
   * Applies the desired state. Auto-start is a convenience, never a reason to
   * fail a launch, so every failure is logged rather than thrown.
   */
  apply(enabled: boolean): void {
    try {
      switch (process.platform) {
        case 'linux':
          this.applyDesktopEntry(enabled);
          break;
        case 'darwin':
          app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: enabled });
          break;
        default:
          app.setLoginItemSettings({ openAtLogin: enabled, ...this.windowsLoginItemOptions() });
      }

      this.logger.info(`Auto-start ${enabled ? 'enabled' : 'disabled'}`, {
        platform: process.platform,
      });
    } catch (error) {
      this.logger.error('Failed to apply auto-start setting', { error, enabled });
    }
  }

  /** Whether the OS currently has us registered to launch at login. */
  isEnabled(): boolean {
    try {
      if (process.platform === 'linux') {
        return fs.existsSync(this.desktopEntryPath());
      }
      return app.getLoginItemSettings(this.windowsLoginItemOptions()).openAtLogin;
    } catch (error) {
      this.logger.warn('Failed to read auto-start setting', { error });
      return false;
    }
  }

  /** True when this instance was started by the OS at login. */
  wasLaunchedInBackground(): boolean {
    if (process.argv.includes(BACKGROUND_LAUNCH_FLAG)) {
      return true;
    }

    if (process.platform === 'linux') {
      return false;
    }

    try {
      // Windows reports neither of these, which is why the login item
      // registers BACKGROUND_LAUNCH_FLAG in its arguments instead.
      const settings = app.getLoginItemSettings(this.windowsLoginItemOptions());
      return Boolean(settings.wasOpenedAtLogin || settings.wasOpenedAsHidden);
    } catch {
      return false;
    }
  }

  /**
   * Windows keys its Run entry by executable path and arguments, so the same
   * options must be passed when reading the setting back.
   */
  private windowsLoginItemOptions(): { path?: string; args?: string[] } {
    if (process.platform !== 'win32') {
      return {};
    }
    return { path: process.execPath, args: [BACKGROUND_LAUNCH_FLAG] };
  }

  private desktopEntryPath(): string {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    return path.join(configHome, 'autostart', LINUX_AUTOSTART_ENTRY);
  }

  private applyDesktopEntry(enabled: boolean): void {
    const entryPath = this.desktopEntryPath();

    if (!enabled) {
      if (fs.existsSync(entryPath)) {
        fs.unlinkSync(entryPath);
      }
      return;
    }

    // An AppImage executes from a temporary mount point, so the launcher has
    // to point at the image itself rather than the extracted executable.
    const executable = process.env.APPIMAGE || process.execPath;
    const entry = [
      '[Desktop Entry]',
      'Type=Application',
      'Name=Novaris Agent',
      `Exec="${executable}" ${BACKGROUND_LAUNCH_FLAG}`,
      'Terminal=false',
      'X-GNOME-Autostart-enabled=true',
      '',
    ].join('\n');

    fs.mkdirSync(path.dirname(entryPath), { recursive: true });
    fs.writeFileSync(entryPath, entry, 'utf-8');
  }
}
