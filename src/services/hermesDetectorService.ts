import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { getLogger } from '../utils/logger';

export interface HermesDetectionResult {
  detected: boolean;
  /** Executable or installation path that proved Hermes is installed. */
  detectedAt: string | null;
  /** Which detection strategy matched. */
  method: 'env' | 'known-path' | 'path-executable' | null;
  /** Exact executable Novaris can invoke. */
  executablePath: string | null;
  /** Profile-aware Hermes configuration directory. */
  hermesHome: string;
}

interface HermesExecutableMatch {
  executablePath: string;
  hermesHome: string;
  method: NonNullable<HermesDetectionResult['method']>;
}

/**
 * Detects an existing Hermes Agent installation without mutating it.
 *
 * Native Windows installs commonly place an extensionless PE executable at
 * `%LOCALAPPDATA%/hermes/hermes-agent/venv/Scripts/hermes`. Electron does not
 * always inherit the same PATH as Git Bash, so discovery checks that layout
 * explicitly in addition to environment variables and PATH.
 */
export class HermesDetectorService {
  private readonly logger = getLogger();

  detect(): HermesDetectionResult {
    const match = this.detectFromEnvironment()
      || this.detectFromKnownPaths()
      || this.detectFromPathExecutable();

    if (!match) {
      return {
        detected: false,
        detectedAt: null,
        method: null,
        executablePath: null,
        hermesHome: this.getHermesHome(),
      };
    }

    this.logger.info('Existing Hermes installation detected', {
      method: match.method,
      path: match.executablePath,
      hermesHome: match.hermesHome,
    });

    return {
      detected: true,
      detectedAt: match.executablePath,
      method: match.method,
      executablePath: match.executablePath,
      hermesHome: match.hermesHome,
    };
  }

  private detectFromEnvironment(): HermesExecutableMatch | null {
    const explicitExecutable = process.env.HERMES_EXECUTABLE_PATH;
    if (explicitExecutable && this.isFile(explicitExecutable)) {
      return this.match(explicitExecutable, 'env');
    }

    for (const envVar of ['HERMES_INSTALL_PATH', 'HERMES_HOME']) {
      const root = process.env[envVar];
      if (!root) continue;
      const executable = this.findExecutableUnder(root);
      if (executable) return this.match(executable, 'env');
    }

    return null;
  }

  private detectFromKnownPaths(): HermesExecutableMatch | null {
    for (const root of this.getKnownInstallRoots()) {
      const executable = this.findExecutableUnder(root);
      if (executable) return this.match(executable, 'known-path');
    }
    return null;
  }

  private detectFromPathExecutable(): HermesExecutableMatch | null {
    const pathEnv = process.env.PATH || process.env.Path || '';
    if (!pathEnv) return null;

    for (const directory of pathEnv.split(path.delimiter).filter(Boolean)) {
      for (const executableName of this.getExecutableNames()) {
        const candidate = path.join(directory, executableName);
        if (this.isFile(candidate)) return this.match(candidate, 'path-executable');
      }
    }
    return null;
  }

  private findExecutableUnder(root: string): string | null {
    if (this.isFile(root)) return root;

    const relativeDirectories = process.platform === 'win32'
      ? [
        '',
        'bin',
        path.join('Scripts'),
        path.join('venv', 'Scripts'),
        path.join('.venv', 'Scripts'),
        path.join('hermes-agent', 'venv', 'Scripts'),
        path.join('hermes-agent', '.venv', 'Scripts'),
      ]
      : [
        '',
        'bin',
        path.join('venv', 'bin'),
        path.join('.venv', 'bin'),
        path.join('hermes-agent', 'venv', 'bin'),
        path.join('hermes-agent', '.venv', 'bin'),
      ];

    for (const relativeDirectory of relativeDirectories) {
      for (const executableName of this.getExecutableNames()) {
        const candidate = path.join(root, relativeDirectory, executableName);
        if (this.isFile(candidate)) return candidate;
      }
    }
    return null;
  }

  private getExecutableNames(): string[] {
    return process.platform === 'win32'
      ? ['hermes', 'hermes.exe', 'hermes.cmd', 'hermes.bat']
      : ['hermes'];
  }

  private getKnownInstallRoots(): string[] {
    const homeDir = os.homedir();
    const defaultHome = this.getHermesHome();
    const candidates = process.platform === 'win32'
      ? [
        defaultHome,
        path.join(process.env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local'), 'Hermes'),
        path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Hermes'),
        path.join(homeDir, '.hermes'),
      ]
      : process.platform === 'darwin'
        ? [defaultHome, '/usr/local/hermes', '/Applications/Hermes.app', path.join(homeDir, 'Library', 'Application Support', 'Hermes')]
        : [defaultHome, '/opt/hermes', '/usr/local/hermes'];

    const seen = new Set<string>();
    return candidates.filter((candidate) => {
      const normalized = path.resolve(candidate).toLowerCase();
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
  }

  private getHermesHome(): string {
    if (process.env.HERMES_HOME) return path.resolve(process.env.HERMES_HOME);
    return process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'hermes')
      : path.join(os.homedir(), '.hermes');
  }

  private match(executablePath: string, method: NonNullable<HermesDetectionResult['method']>): HermesExecutableMatch {
    return {
      executablePath: path.resolve(executablePath),
      hermesHome: this.getHermesHome(),
      method,
    };
  }

  private isFile(candidate: string): boolean {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch (_error) {
      return false;
    }
  }
}
