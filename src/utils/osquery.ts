import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { getLogger } from './logger';

const execFileAsync = promisify(execFile);

type OsqueryPlatformDir = 'win32' | 'darwin' | 'linux';

function platformDirFor(platform: NodeJS.Platform): OsqueryPlatformDir | null {
  if (platform === 'win32') return 'win32';
  if (platform === 'darwin') return 'darwin';
  if (platform === 'linux') return 'linux';
  return null;
}

function resolveBinaryPath(): string | null {
  const platform = os.platform();
  const platformDir = platformDirFor(platform);
  if (!platformDir) {
    return null;
  }

  const binaryName = platformDir === 'win32' ? 'osqueryi.exe' : 'osqueryi';
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;

  const candidates: string[] = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'osquery', platformDir, binaryName));
  }
  candidates.push(path.join(process.cwd(), 'resources', 'osquery', platformDir, binaryName));

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

let cachedBinaryPath: string | null | undefined;

function getBinaryPath(): string | null {
  if (cachedBinaryPath === undefined) {
    cachedBinaryPath = resolveBinaryPath();
  }
  return cachedBinaryPath;
}

/**
 * Whether a bundled osqueryi binary was found for this platform/architecture.
 * Callers should check this before relying on queryOsquery's result being
 * meaningful (an empty array from queryOsquery can also mean "0 rows", so
 * this is the only reliable way to distinguish "osquery unavailable" from
 * "osquery ran and found nothing").
 */
export function isOsqueryAvailable(): boolean {
  return getBinaryPath() !== null;
}

/**
 * Run a single SQL query against the bundled osqueryi binary and parse its
 * JSON output. Never throws - matches every other collector's convention of
 * logging and returning a safe empty default on any failure (missing binary,
 * bad query, timeout, unparseable output).
 */
export async function queryOsquery<T = Record<string, string>>(sql: string): Promise<T[]> {
  const logger = getLogger();
  const binaryPath = getBinaryPath();

  if (!binaryPath) {
    logger.debug('osquery binary not available, skipping query', { sql });
    return [];
  }

  try {
    const { stdout } = await execFileAsync(binaryPath, ['--json', sql], {
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
    });
    const raw = (stdout || '').trim();
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (error: any) {
    logger.warn('osquery query failed', { sql, error: error?.message || error });
    return [];
  }
}
