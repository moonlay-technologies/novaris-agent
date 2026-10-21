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
  // The background service runs compiled dist/ under plain Node; the package root sits above it
  candidates.push(path.join(__dirname, '..', '..', 'resources', 'osquery', platformDir, binaryName));

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

/** Outcome of an osquery query, keeping "unavailable" and "failed" apart from "no rows". */
export type OsqueryResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; reason: 'tool_unavailable' | 'timeout' | 'command_failed' | 'parse_error'; error: string };

/** Read access to osquery, as evidence packs see it (replaceable in tests). */
export interface OsqueryClient {
  available(): boolean;
  version(): Promise<string | null>;
  query<T = Record<string, string>>(sql: string): Promise<OsqueryResult<T>>;
}

/**
 * Run a single SQL query against the bundled osqueryi binary. Never throws.
 */
export async function runOsquery<T = Record<string, string>>(sql: string): Promise<OsqueryResult<T>> {
  const binaryPath = getBinaryPath();
  if (!binaryPath) {
    return { ok: false, reason: 'tool_unavailable', error: 'osquery binary not bundled' };
  }

  let stdout: string;
  try {
    const result = await execFileAsync(binaryPath, ['--json', sql], {
      timeout: 30000,
      maxBuffer: 5 * 1024 * 1024,
      windowsHide: true,
    });
    stdout = String(result.stdout || '').trim();
  } catch (error: any) {
    const reason = error?.killed ? 'timeout' : 'command_failed';
    return { ok: false, reason, error: String(error?.message || error).split(/\r?\n/)[0].slice(0, 200) };
  }

  if (!stdout) {
    return { ok: true, rows: [] };
  }
  try {
    const parsed = JSON.parse(stdout);
    return { ok: true, rows: Array.isArray(parsed) ? (parsed as T[]) : [] };
  } catch {
    return { ok: false, reason: 'parse_error', error: 'osquery output was not valid JSON' };
  }
}

let cachedVersion: string | null | undefined;

async function osqueryVersion(): Promise<string | null> {
  if (cachedVersion !== undefined) return cachedVersion;
  const binaryPath = getBinaryPath();
  if (!binaryPath) {
    cachedVersion = null;
    return cachedVersion;
  }
  try {
    const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: 10000, windowsHide: true });
    // "osqueryi version 5.23.1"
    cachedVersion = String(stdout).trim().split(/\s+/).pop() || null;
  } catch {
    cachedVersion = null;
  }
  return cachedVersion;
}

/** The OsqueryClient backed by the bundled binary. */
export const bundledOsquery: OsqueryClient = {
  available: isOsqueryAvailable,
  version: osqueryVersion,
  query: runOsquery,
};

/**
 * Run a single SQL query against the bundled osqueryi binary and parse its
 * JSON output. Never throws - matches every other collector's convention of
 * logging and returning a safe empty default on any failure (missing binary,
 * bad query, timeout, unparseable output).
 */
export async function queryOsquery<T = Record<string, string>>(sql: string): Promise<T[]> {
  const result = await runOsquery<T>(sql);
  if (result.ok) {
    return result.rows;
  }
  const logger = getLogger();
  if (result.reason === 'tool_unavailable') {
    logger.debug('osquery binary not available, skipping query', { sql });
  } else {
    logger.warn('osquery query failed', { sql, error: result.error });
  }
  return [];
}
