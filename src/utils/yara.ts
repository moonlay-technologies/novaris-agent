import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { YaraMatch } from '../types/yara';
import { getLogger } from './logger';

const execFileAsync = promisify(execFile);

type YaraPlatformDir = 'win32' | 'darwin' | 'linux';

function platformDirFor(platform: NodeJS.Platform): YaraPlatformDir | null {
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

  const binaryName = platformDir === 'win32' ? 'yr.exe' : 'yr';
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;

  const candidates: string[] = [];
  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'yara', platformDir, binaryName));
  }
  candidates.push(path.join(process.cwd(), 'resources', 'yara', platformDir, binaryName));

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

export function isYaraAvailable(): boolean {
  return getBinaryPath() !== null;
}

interface YaraScanLineRule {
  identifier: string;
  namespace?: string;
  tags?: string[];
  // yr's ndjson output represents meta as an array of [key, value] pairs, not an object.
  meta?: Array<[string, unknown]>;
}

function metaPairsToObject(pairs: Array<[string, unknown]> | undefined): Record<string, unknown> {
  if (!pairs) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, value] of pairs) {
    result[key] = value;
  }
  return result;
}

interface YaraScanLine {
  path: string;
  rules: YaraScanLineRule[];
}

/**
 * Scans `targetPath` (a file or directory) against every `.yar`/`.yara` rule
 * in `rulesDir` using the bundled `yr` (yara-x) binary. Never throws - logs
 * and returns `[]` on any failure (missing binary, bad rules, timeout), same
 * convention as every other collector/query helper in this codebase.
 */
export async function scanPath(targetPath: string, rulesDir: string): Promise<YaraMatch[]> {
  const logger = getLogger();
  const binaryPath = getBinaryPath();

  if (!binaryPath) {
    logger.debug('yara binary not available, skipping scan', { targetPath, rulesDir });
    return [];
  }

  try {
    const { stdout } = await execFileAsync(
      binaryPath,
      ['scan', '--output-format', 'ndjson', '--print-tags', '--print-meta', '--print-namespace', rulesDir, targetPath],
      { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }
    );

    const matches: YaraMatch[] = [];
    const lines = (stdout || '').split('\n').map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line) as YaraScanLine;
        for (const rule of parsed.rules || []) {
          matches.push({
            ruleName: rule.identifier,
            targetFile: parsed.path,
            tags: rule.tags || [],
            meta: metaPairsToObject(rule.meta),
          });
        }
      } catch (parseError: any) {
        logger.warn('Failed to parse yara ndjson output line', { line, error: parseError?.message || parseError });
      }
    }

    return matches;
  } catch (error: any) {
    // yr exits non-zero when it finds no matches on some versions/flag combos -
    // treat any exec failure as "no matches / scan unavailable" rather than propagating.
    logger.debug('yara scan produced no results or failed', { targetPath, rulesDir, error: error?.message || error });
    return [];
  }
}
