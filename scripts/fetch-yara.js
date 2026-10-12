#!/usr/bin/env node
/**
 * Downloads a pinned yara-x release from the official VirusTotal/yara-x
 * GitHub releases, extracts the `yr` CLI binary, and places it where
 * src/utils/yara.ts expects it for the current platform:
 *   resources/yara/<win32|darwin|linux>/yr[.exe]
 *
 * yara-x is VirusTotal's actively-maintained Rust reimplementation of
 * classic YARA (BSD-3-Clause) - used instead of classic YARA because it
 * publishes genuine portable standalone archives for all three platforms;
 * classic YARA only ships prebuilt binaries for Windows.
 *
 * Usage:
 *   node scripts/fetch-yara.js            # fetch for the current platform
 *   node scripts/fetch-yara.js win32       # or fetch a specific platform explicitly
 *
 * Does not run automatically as part of any build/install script - fetching
 * and placing a third-party executable is a deliberate, explicit step (see
 * resources/yara/README.md).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const YARA_X_VERSION = '1.19.0';

function archAsset(platform) {
  const arch = os.arch(); // 'x64' | 'arm64' | ...
  if (platform === 'win32') {
    return 'x86_64-pc-windows-msvc';
  }
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  if (platform === 'linux') {
    return arch === 'arm64' ? 'aarch64-unknown-linux-gnu' : 'x86_64-unknown-linux-gnu';
  }
  return null;
}

function releaseAssetFor(platform) {
  const asset = archAsset(platform);
  if (!asset) return null;

  const archiveType = platform === 'win32' ? 'zip' : 'tar';
  const ext = platform === 'win32' ? 'zip' : 'tar.gz';
  const fileName = `yara-x-v${YARA_X_VERSION}-${asset}.${ext}`;

  return {
    url: `https://github.com/VirusTotal/yara-x/releases/download/v${YARA_X_VERSION}/${fileName}`,
    archiveType,
    binaryNameInArchive: platform === 'win32' ? 'yr.exe' : 'yr',
    outputName: platform === 'win32' ? 'yr.exe' : 'yr',
  };
}

function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    const request = (requestUrl) => {
      https.get(requestUrl, (response) => {
        if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          request(response.headers.location);
          return;
        }
        if (response.statusCode !== 200) {
          reject(new Error(`Download failed: HTTP ${response.statusCode} for ${requestUrl}`));
          return;
        }
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
      }).on('error', reject);
    };
    request(url);
  });
}

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function findBinaryRecursive(dir, binaryName) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = findBinaryRecursive(fullPath, binaryName);
      if (found) return found;
    } else if (entry.name === binaryName) {
      return fullPath;
    }
  }
  return null;
}

async function main() {
  const platform = process.argv[2] || os.platform();
  const asset = releaseAssetFor(platform);
  if (!asset) {
    console.error(`No known yara-x release asset mapping for platform/arch "${platform}"/"${os.arch()}".`);
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'resources', 'yara', platform);
  fs.mkdirSync(outDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-yara-'));
  const archiveExt = asset.archiveType === 'zip' ? '.zip' : '.tar.gz';
  const archivePath = path.join(tmpDir, `yara-x${archiveExt}`);

  console.log(`Downloading yara-x ${YARA_X_VERSION} for ${platform} from:\n  ${asset.url}`);
  await download(asset.url, archivePath);

  const hash = sha256(archivePath);
  console.log(`Downloaded. SHA256: ${hash}`);
  console.log(`Cross-check this against the checksum published at https://github.com/VirusTotal/yara-x/releases/tag/v${YARA_X_VERSION} before trusting it in a build you'll distribute.`);

  const extractDir = path.join(tmpDir, 'extracted');
  fs.mkdirSync(extractDir, { recursive: true });
  console.log('Extracting...');
  if (asset.archiveType === 'zip') {
    // Shell `tar` may resolve to GNU tar (e.g. Git Bash/MSYS2 on Windows), which
    // can't read .zip at all (only bsdtar/libarchive can) - use PowerShell's
    // Expand-Archive instead, which is always available on Windows.
    execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `Expand-Archive -Path "${archivePath}" -DestinationPath "${extractDir}" -Force`,
    ], { stdio: 'inherit' });
  } else {
    // --force-local: without it, tar/bsdtar treats a "C:\..." path as a remote
    // "host:path" spec (because of the drive-letter colon) and fails to resolve "C" as a host.
    execFileSync('tar', ['--force-local', '-xzf', archivePath, '-C', extractDir], { stdio: 'inherit' });
  }

  const found = findBinaryRecursive(extractDir, asset.binaryNameInArchive);
  if (!found) {
    console.error(`Could not find "${asset.binaryNameInArchive}" inside the extracted archive at ${extractDir}. Archive layout may have changed for this release.`);
    process.exit(1);
  }

  const outPath = path.join(outDir, asset.outputName);
  fs.copyFileSync(found, outPath);
  if (platform !== 'win32') {
    fs.chmodSync(outPath, 0o755);
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\nPlaced yara-x binary at: ${outPath}`);
}

main().catch((error) => {
  console.error('fetch-yara failed:', error.message || error);
  process.exit(1);
});
