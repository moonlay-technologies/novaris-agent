import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../utils/logger';

export interface HermesDetectionResult {
  detected: boolean;
  /** Where the existing installation was found, for diagnostics/logging only. */
  detectedAt: string | null;
  /** Which detection strategy matched. */
  method: 'env' | 'known-path' | 'path-executable' | null;
}

/**
 * Detects whether a Hermes Agent runtime is already installed on this
 * machine, independent of Novaris. Used before running the managed/bundled
 * Hermes install flow so we never install a second, conflicting instance
 * on top of a user's existing setup.
 *
 * This is a best-effort, read-only filesystem/env check. It never spawns
 * processes and never modifies anything on disk.
 */
export class HermesDetectorService {
  private logger = getLogger();

  detect(): HermesDetectionResult {
    const envResult = this.detectFromEnv();
    if (envResult) {
      this.logger.info('Existing Hermes installation detected via environment variable', {
        path: envResult,
      });
      return { detected: true, detectedAt: envResult, method: 'env' };
    }

    const knownPathResult = this.detectFromKnownPaths();
    if (knownPathResult) {
      this.logger.info('Existing Hermes installation detected at known install path', {
        path: knownPathResult,
      });
      return { detected: true, detectedAt: knownPathResult, method: 'known-path' };
    }

    const pathExecutableResult = this.detectFromPathExecutable();
    if (pathExecutableResult) {
      this.logger.info('Existing Hermes executable detected on PATH', {
        path: pathExecutableResult,
      });
      return { detected: true, detectedAt: pathExecutableResult, method: 'path-executable' };
    }

    return { detected: false, detectedAt: null, method: null };
  }

  private detectFromEnv(): string | null {
    const candidateEnvVars = ['HERMES_HOME', 'HERMES_INSTALL_PATH'];

    for (const envVar of candidateEnvVars) {
      const value = process.env[envVar];
      if (value && this.installationPathExists(value)) {
        return value;
      }
    }

    return null;
  }

  private detectFromKnownPaths(): string | null {
    for (const candidate of this.getKnownInstallPaths()) {
      if (this.installationPathExists(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private getKnownInstallPaths(): string[] {
    const homeDir = os.homedir();

    switch (process.platform) {
      case 'win32':
        return [
          path.join(process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'Hermes'),
          path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Hermes'),
          path.join(homeDir, '.hermes'),
        ];
      case 'darwin':
        return [
          '/usr/local/hermes',
          '/Applications/Hermes.app',
          path.join(homeDir, 'Library', 'Application Support', 'Hermes'),
          path.join(homeDir, '.hermes'),
        ];
      default:
        return ['/opt/hermes', '/usr/local/hermes', path.join(homeDir, '.hermes')];
    }
  }

  private detectFromPathExecutable(): string | null {
    const pathEnv = process.env.PATH || process.env.Path || '';
    if (!pathEnv) {
      return null;
    }

    const executableNames = process.platform === 'win32' ? ['hermes.exe', 'hermes.cmd'] : ['hermes'];
    const directories = pathEnv.split(path.delimiter).filter(Boolean);

    for (const dir of directories) {
      for (const executableName of executableNames) {
        const candidate = path.join(dir, executableName);
        if (this.installationPathExists(candidate)) {
          return candidate;
        }
      }
    }

    return null;
  }

  private installationPathExists(candidate: string): boolean {
    try {
      if (!fs.existsSync(candidate)) {
        return false;
      }

      if (fs.statSync(candidate).isFile()) {
        return true;
      }

      const executableNames = process.platform === 'win32' ? ['hermes.exe', 'hermes.cmd'] : ['hermes'];
      return executableNames.some((executableName) => fs.existsSync(path.join(candidate, executableName)));
    } catch (_error) {
      return false;
    }
  }
}
