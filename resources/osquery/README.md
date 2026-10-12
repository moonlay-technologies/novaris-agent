# osquery binaries (not committed)

`src/utils/osquery.ts` looks for a bundled `osqueryi` binary at:

- `resources/osquery/win32/osqueryi.exe` (dev) / packaged app's `resources/osquery/win32/osqueryi.exe`
- `resources/osquery/darwin/osqueryi` (dev) / packaged app's `resources/osquery/darwin/osqueryi`
- `resources/osquery/linux/osqueryi` (dev) / packaged app's `resources/osquery/linux/osqueryi`

**There is no shell-based fallback anymore** — the old PowerShell/`fdesetup`/`lsblk` disk-encryption checks and the old registry/`system_profiler`/`dpkg`/`rpm` software-fallback scraping were removed once osquery replaced them. If the binary isn't present, `queryOsquery()` just returns an empty result (logged at debug level, never throws), so collection still completes without crashing — but disk-encryption status and the software-inventory fallback path will report nothing until a binary is placed here. This is a deliberate tradeoff: simpler code, at the cost of requiring the binary to actually be present for these two checks to produce real data.

## Fetching the binary

```bash
npm run fetch-osquery            # fetches for the current machine's platform
node scripts/fetch-osquery.js win32   # or fetch a specific platform explicitly
```

`scripts/fetch-osquery.js` downloads a **pinned version** (currently 5.23.1) from the official [osquery/osquery releases](https://github.com/osquery/osquery/releases) — the portable `.zip`/`.tar.gz` archives, not the MSI/PKG/DEB installers meant for full system installs — extracts the `osqueryi` binary, and places it at the path above. It prints the SHA256 of what it downloaded so you can cross-check it against the release page before trusting it in anything you'll distribute.

**This does not run automatically** as part of `npm install`, `npm run dev`, or `npm run dist` — fetching and bundling a third-party executable is a decision worth making explicitly (which version, verified how) rather than something a script does silently on every install. Bump `OSQUERY_VERSION` in the script when you want to move to a newer release.

We fetch from the official osquery/osquery releases rather than the `Velocidex/OSQuery-Releases` standalone-binary redistribution some guides point to — that fork hasn't been updated since v4.4.0 in 2020, while the official project ships current, actively-maintained portable archives directly.

These binaries are gitignored (see `.gitignore`) — they're third-party executables, not source, and shouldn't bloat the repo history. `package.json`'s `build.mac/win/linux.extraResources` points electron-builder at these folders, so `npm run dist` bundles whatever's here into the packaged app automatically.
