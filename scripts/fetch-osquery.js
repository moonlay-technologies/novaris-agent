#!/usr/bin/env node
/**
 * Downloads a pinned osquery release from the official osquery/osquery GitHub
 * releases (not the stale Velocidex standalone-binary fork, which hasn't been
 * updated since 2020 - v4.4.0), extracts the osqueryi/osqueryd binary, and
 * places it where src/utils/osquery.ts expects it for the current platform:
 *   resources/osquery/<win32|darwin|linux>/osqueryi[.exe]
 *
 * Usage:
 *   node scripts/fetch-osquery.js            # fetch for the current platform
 *   node scripts/fetch-osquery.js win32       # fetch for a specific platform
 *
 * This intentionally does not run automatically as part of `npm install` or
 * any build script - fetching and placing a third-party executable is a
 * deliberate, explicit step (see resources/osquery/README.md).
 */

const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const OSQUERY_VERSION = '5.23.1';

// Official osquery/osquery release assets - portable archives, no system install.
const RELEASE_ASSETS = {
  win32: {
    url: `https://github.com/osquery/osquery/releases/download/${OSQUERY_VERSION}/osquery-${OSQUERY_VERSION}.windows_x86_64.zip`,
    archiveType: 'zip',
    binaryNameInArchive: 'osqueryi.exe',
    outputName: 'osqueryi.exe',
  },
  darwin: {
    // Note: macOS releases only ship an arm64 tarball from this version onward -
    // this will need a Rosetta/x86_64 fallback strategy if Intel Mac support matters.
    url: `https://github.com/osquery/osquery/releases/download/${OSQUERY_VERSION}/osquery-${OSQUERY_VERSION}_1.macos_arm64.tar.gz`,
    archiveType: 'tar',
    binaryNameInArchive: 'osqueryi',
    outputName: 'osqueryi',
  },
  linux: {
    url: `https://github.com/osquery/osquery/releases/download/${OSQUERY_VERSION}/osquery-${OSQUERY_VERSION}_1.linux_x86_64.tar.gz`,
    archiveType: 'tar',
    binaryNameInArchive: 'osqueryi',
    outputName: 'osqueryi',
  },
};

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
  const asset = RELEASE_ASSETS[platform];
  if (!asset) {
    console.error(`No known osquery release asset mapping for platform "${platform}". Supported: ${Object.keys(RELEASE_ASSETS).join(', ')}`);
    process.exit(1);
  }

  const outDir = path.join(__dirname, '..', 'resources', 'osquery', platform);
  fs.mkdirSync(outDir, { recursive: true });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-osquery-'));
  const archiveExt = asset.archiveType === 'zip' ? '.zip' : '.tar.gz';
  const archivePath = path.join(tmpDir, `osquery${archiveExt}`);

  console.log(`Downloading osquery ${OSQUERY_VERSION} for ${platform} from:\n  ${asset.url}`);
  await download(asset.url, archivePath);

  const hash = sha256(archivePath);
  console.log(`Downloaded. SHA256: ${hash}`);
  console.log(`Cross-check this against the checksum published at https://github.com/osquery/osquery/releases/tag/${OSQUERY_VERSION} before trusting it in a build you'll distribute.`);

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

  console.log(`\nPlaced osquery binary at: ${outPath}`);
}

main().catch((error) => {
  console.error('fetch-osquery failed:', error.message || error);
  process.exit(1);
});
