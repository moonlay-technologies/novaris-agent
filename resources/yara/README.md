# yara-x binary (not committed)

`src/utils/yara.ts` looks for a bundled `yr` binary at:

- `resources/yara/win32/yr.exe`
- `resources/yara/darwin/yr`
- `resources/yara/linux/yr`

If the binary isn't present, `scanPath()` just returns an empty result (logged at debug level, never throws) - the periodic YARA scan and the `scan_path` response action both degrade to "no matches" rather than crashing.

## Fetching the binary

```bash
npm run fetch-yara            # fetches for the current machine's platform/arch
node scripts/fetch-yara.js win32   # or fetch a specific platform explicitly
```

`scripts/fetch-yara.js` downloads a **pinned version** (currently 1.19.0) from the official [VirusTotal/yara-x releases](https://github.com/VirusTotal/yara-x/releases) - the portable `.zip`/`.tar.gz` archives - extracts the `yr` binary, and places it at the path above. It prints the SHA256 of what it downloaded so you can cross-check it against the release page before trusting it in anything you'll distribute.

**This does not run automatically** as part of `npm install`, `npm run dev`, or `npm run dist` - same reasoning as the osquery fetch script. Bump `YARA_X_VERSION` in the script when you want to move to a newer release.

We use **yara-x** (VirusTotal's actively-maintained Rust reimplementation of YARA, BSD-3-Clause) rather than classic YARA - classic YARA only publishes prebuilt binaries for Windows; macOS requires Homebrew and Linux requires compiling from source. yara-x ships genuine portable archives for Windows, macOS (Intel + Apple Silicon), and Linux (x64 + ARM) on every release.

These binaries are gitignored - they're third-party executables, not source, and shouldn't bloat the repo history. `package.json`'s `build.mac/win/linux.extraResources` points electron-builder at these folders, so `npm run dist` bundles whatever's here into the packaged app automatically.
