import { execFile } from 'child_process';
import * as path from 'path';
import { getLogger } from '../../dist/utils/logger';

/** How the headless agent is registered with the operating system. */
export type BackgroundServiceKind = 'scheduled-task' | 'systemd' | 'launchd';

export interface BackgroundServiceStatus {
  /** A headless Novaris agent is registered on this machine. */
  installed: boolean;
  /** That headless agent is running right now, and is the one reporting. */
  running: boolean;
  kind: BackgroundServiceKind | null;
}

const NOT_DETECTED: BackgroundServiceStatus = { installed: false, running: false, kind: null };

const WINDOWS_TASK_NAME = 'NovarisAgent';
const SYSTEMD_UNIT_NAME = 'novaris-agent';
const LAUNCHD_LABEL = 'com.novaris.agent';
const COMMAND_TIMEOUT_MS = 5000;

interface CommandResult {
  code: number;
  stdout: string;
}

/**
 * Detects the headless agent installed by the platform installers, which runs
 * at boot under the system account.
 *
 * The desktop application uses this to stay out of its way: two agents
 * reporting for the same asset tag would double every metric the backend
 * receives.
 */
export class BackgroundServiceDetector {
  private get logger() {
    return getLogger();
  }

  async detect(): Promise<BackgroundServiceStatus> {
    try {
      switch (process.platform) {
        case 'win32':
          return await this.detectScheduledTask();
        case 'linux':
          return await this.detectSystemdUnit();
        case 'darwin':
          return await this.detectLaunchDaemon();
        default:
          return NOT_DETECTED;
      }
    } catch (error) {
      // Never let detection stop a launch: treat an unknown answer as absent,
      // which leaves the desktop agent behaving as it always has.
      this.logger.warn('Failed to detect the background agent service', { error });
      return NOT_DETECTED;
    }
  }

  /**
   * Asks PowerShell rather than parsing schtasks output, whose field names and
   * values are translated on localized copies of Windows.
   */
  private async detectScheduledTask(): Promise<BackgroundServiceStatus> {
    const powershell = process.env.SystemRoot
      ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      : 'powershell.exe';

    const { stdout } = await this.run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `(Get-ScheduledTask -TaskName '${WINDOWS_TASK_NAME}' -ErrorAction SilentlyContinue).State`,
    ]);

    const state = stdout.trim();
    if (!state) {
      return NOT_DETECTED;
    }

    return {
      installed: true,
      // Running means an instance of the task action is executing, which for a
      // boot-triggered task holds for as long as the agent process lives.
      running: state === 'Running',
      kind: 'scheduled-task',
    };
  }

  private async detectSystemdUnit(): Promise<BackgroundServiceStatus> {
    const active = await this.run('systemctl', ['is-active', SYSTEMD_UNIT_NAME]);

    if (active.stdout.trim() === 'active') {
      return { installed: true, running: true, kind: 'systemd' };
    }

    const enabled = await this.run('systemctl', ['is-enabled', SYSTEMD_UNIT_NAME]);
    const enabledState = enabled.stdout.trim();

    // An unknown unit reports nothing useful on stdout
    if (!enabledState || enabledState.includes('No such file')) {
      return NOT_DETECTED;
    }

    return { installed: true, running: false, kind: 'systemd' };
  }

  private async detectLaunchDaemon(): Promise<BackgroundServiceStatus> {
    const { code, stdout } = await this.run('launchctl', ['list', LAUNCHD_LABEL]);

    if (code !== 0) {
      return NOT_DETECTED;
    }

    // launchctl only reports a PID entry while the daemon is actually up
    return {
      installed: true,
      running: /"PID"\s*=\s*\d+/.test(stdout),
      kind: 'launchd',
    };
  }

  /** Runs a query command, treating a non-zero exit as an answer, not a fault. */
  private run(command: string, args: string[]): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      execFile(
        command,
        args,
        { timeout: COMMAND_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error && typeof (error as NodeJS.ErrnoException).code === 'string') {
            // The tool itself is missing or timed out
            reject(error);
            return;
          }

          resolve({
            code: error ? Number((error as NodeJS.ErrnoException).code ?? 1) : 0,
            stdout: stdout ? stdout.toString() : '',
          });
        }
      );
    });
  }
}
