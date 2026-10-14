import axios from 'axios';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import { getLogger } from '../utils/logger';
import {
  getYaraBinaryPath,
  resetYaraBinaryCache,
  yaraBinaryName,
  yaraPluginDirectory,
} from '../utils/yara';

const execFileAsync = promisify(execFile);

/** Pinned yara-x release. Bump together with the digests below. */
export const YARA_X_VERSION = '1.19.0';

interface ReleaseAsset {
  fileName: string;
  sha256: string;
}

// SHA256 digests published by GitHub for the v1.19.0 release assets
const RELEASE_ASSETS: Record<string, ReleaseAsset> = {
  'win32-x64': { fileName: `yara-x-v${YARA_X_VERSION}-x86_64-pc-windows-msvc.zip`, sha256: 'a68d3fcc9cb846a92a1233a6581ee21e777cd5c404d00eebf0628b25900c4f0d' },
  'darwin-x64': { fileName: `yara-x-v${YARA_X_VERSION}-x86_64-apple-darwin.tar.gz`, sha256: '2c9b9778890d2e2bb10faf0ce21087e6cf012793ba90bb611cdc0b06e18b44e8' },
  'darwin-arm64': { fileName: `yara-x-v${YARA_X_VERSION}-aarch64-apple-darwin.tar.gz`, sha256: 'b6e62d6388412a86655340513ccfd7ac9ea5e98868e870dd4a4c029909ebf87b' },
  'linux-x64': { fileName: `yara-x-v${YARA_X_VERSION}-x86_64-unknown-linux-gnu.tar.gz`, sha256: 'a97d78189e3548797ac45b7b4a5fd8975783861875c594f772ec9b8bb5fa4d72' },
  'linux-arm64': { fileName: `yara-x-v${YARA_X_VERSION}-aarch64-unknown-linux-gnu.tar.gz`, sha256: '20443fc16081c68f7a2ca070feb84ae33a89c7dc726851bf050690e55937db77' },
};

export interface YaraPluginStatus {
  installed: boolean;
  /** 'plugin' when installed from the app, 'bundled' when shipped with the installer. */
  source: 'plugin' | 'bundled' | null;
  version: string | null;
  supported: boolean;
}

/** Installs and removes the yara-x scanner binary used by the YARA malware scan. */
export class YaraPluginService {
  private logger = getLogger();

  private releaseAsset(): ReleaseAsset | null {
    return RELEASE_ASSETS[`${os.platform()}-${os.arch()}`] ?? null;
  }

  private pluginBinaryPath(): string | null {
    const dir = yaraPluginDirectory();
    return dir ? path.join(dir, yaraBinaryName()) : null;
  }

  async status(): Promise<YaraPluginStatus> {
    resetYaraBinaryCache();
    const binaryPath = getYaraBinaryPath();
    const supported = this.releaseAsset() !== null;
    if (!binaryPath) {
      return { installed: false, source: null, version: null, supported };
    }

    let version: string | null = null;
    try {
      const { stdout } = await execFileAsync(binaryPath, ['--version'], { timeout: 10000, windowsHide: true });
      version = stdout.trim().replace(/^(yr|yara-x-cli)\s+/i, '') || null;
    } catch (error) {
      this.logger.warn('Unable to read yara-x version', { error });
    }

    return {
      installed: true,
      source: binaryPath === this.pluginBinaryPath() ? 'plugin' : 'bundled',
      version,
      supported,
    };
  }

  async install(): Promise<YaraPluginStatus> {
    const asset = this.releaseAsset();
    const targetDir = yaraPluginDirectory();
    if (!asset || !targetDir) {
      throw new Error(`YARA is not available for ${os.platform()}/${os.arch()}`);
    }

    const url = `https://github.com/VirusTotal/yara-x/releases/download/v${YARA_X_VERSION}/${asset.fileName}`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-yara-'));
    try {
      this.logger.info('Downloading yara-x', { version: YARA_X_VERSION, url });
      const response = await axios.get<ArrayBuffer>(url, { responseType: 'arraybuffer', timeout: 120000 });
      const archive = Buffer.from(response.data);

      const digest = createHash('sha256').update(archive).digest('hex');
      if (digest !== asset.sha256) {
        throw new Error('Downloaded YARA package failed its integrity check');
      }

      const archivePath = path.join(tmpDir, asset.fileName);
      fs.writeFileSync(archivePath, archive);
      const extractDir = path.join(tmpDir, 'extracted');
      fs.mkdirSync(extractDir);
      await this.extract(archivePath, extractDir);

      const extracted = this.findFile(extractDir, yaraBinaryName());
      if (!extracted) {
        throw new Error('The YARA package did not contain the scanner binary');
      }

      fs.mkdirSync(targetDir, { recursive: true });
      const target = path.join(targetDir, yaraBinaryName());
      fs.copyFileSync(extracted, target);
      if (os.platform() !== 'win32') {
        fs.chmodSync(target, 0o755);
      }
      this.logger.info('yara-x installed', { path: target });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }

    return this.status();
  }

  /** Removes an app-installed binary. A bundled binary is part of the installation and is left alone. */
  async uninstall(): Promise<YaraPluginStatus> {
    const dir = yaraPluginDirectory();
    if (dir) {
      fs.rmSync(dir, { recursive: true, force: true });
      this.logger.info('yara-x plugin removed', { path: dir });
    }
    return this.status();
  }

  private async extract(archivePath: string, destination: string): Promise<void> {
    if (archivePath.endsWith('.zip')) {
      await execFileAsync('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        'Expand-Archive -LiteralPath $env:NOVARIS_ARCHIVE -DestinationPath $env:NOVARIS_DEST -Force',
      ], { env: { ...process.env, NOVARIS_ARCHIVE: archivePath, NOVARIS_DEST: destination }, windowsHide: true });
      return;
    }
    await execFileAsync('tar', ['-xzf', archivePath, '-C', destination]);
  }

  private findFile(dir: string, name: string): string | null {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = this.findFile(fullPath, name);
        if (found) return found;
      } else if (entry.name === name) {
        return fullPath;
      }
    }
    return null;
  }
}
