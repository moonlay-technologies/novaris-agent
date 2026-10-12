import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { scanPath } from '../utils/yara';
import { YaraMatch } from '../types/yara';
import { getLogger } from '../utils/logger';

export interface YaraScanCollectorOptions {
  rulesDir: string;
  scanPaths?: string[];
  maxFiles?: number;
  maxFileSizeBytes?: number;
}

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_SIZE_BYTES = 25 * 1024 * 1024; // 25MB

function defaultScanPaths(): string[] {
  const home = os.homedir();
  const platform = os.platform();

  const paths = [path.join(home, 'Downloads'), path.join(home, 'Desktop'), os.tmpdir()];

  if (platform === 'win32') {
    paths.push(path.join(home, 'AppData', 'Local', 'Temp'));
  }

  return paths;
}

/**
 * Collects a bounded list of files under `dirs` (top level + one level of
 * subdirectories, so it covers e.g. Downloads/some-zip-extracted-here without
 * risking a runaway deep recursive walk), skipping anything over
 * `maxFileSizeBytes`, and stopping once `maxFiles` total have been collected.
 */
function collectCandidateFiles(dirs: string[], maxFiles: number, maxFileSizeBytes: number): string[] {
  const files: string[] = [];

  const scanDir = (dir: string, depth: number) => {
    if (files.length >= maxFiles) {
      return;
    }
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // directory doesn't exist or isn't accessible - skip silently
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        return;
      }
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (depth < 1) {
          scanDir(fullPath, depth + 1);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      try {
        const stats = fs.statSync(fullPath);
        if (stats.size > maxFileSizeBytes) {
          continue;
        }
        files.push(fullPath);
      } catch {
        continue;
      }
    }
  };

  for (const dir of dirs) {
    scanDir(dir, 0);
  }

  return files;
}

export class YaraScanCollector {
  private logger = getLogger();

  async collect(options: YaraScanCollectorOptions): Promise<YaraMatch[]> {
    const scanPaths = options.scanPaths?.length ? options.scanPaths : defaultScanPaths();
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    const maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

    const candidates = collectCandidateFiles(scanPaths, maxFiles, maxFileSizeBytes);
    this.logger.debug(`YARA scan: checking ${candidates.length} files across ${scanPaths.length} directories`);

    const matches: YaraMatch[] = [];
    for (const filePath of candidates) {
      const fileMatches = await scanPath(filePath, options.rulesDir);
      matches.push(...fileMatches);
    }

    if (matches.length > 0) {
      this.logger.warn(`YARA scan found ${matches.length} match(es)`, {
        rules: [...new Set(matches.map((m) => m.ruleName))],
      });
    }

    return matches;
  }
}
