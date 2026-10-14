"""Builds the bundled runtime: `uv run python build.py` -> dist/novaris-runtime/.

PyInstaller cannot cross-compile, so run this on each target OS (see the CI workflow).
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
TIKTOKEN_CACHE = ROOT / "build" / "tiktoken_cache"
ENCODINGS = ("cl100k_base", "o200k_base")


def prefetch_tiktoken() -> None:
    """Bundles token encodings so nothing is downloaded on user devices. Best effort."""
    TIKTOKEN_CACHE.mkdir(parents=True, exist_ok=True)
    os.environ["TIKTOKEN_CACHE_DIR"] = str(TIKTOKEN_CACHE)
    try:
        import tiktoken

        for name in ENCODINGS:
            tiktoken.get_encoding(name)
        print(f"Bundling tiktoken encodings: {', '.join(ENCODINGS)}")
    except Exception as error:  # noqa: BLE001 - offline builds still work; the runtime uses approximate counts
        print(f"warning: could not prefetch tiktoken encodings ({error}); continuing without them")
        shutil.rmtree(TIKTOKEN_CACHE, ignore_errors=True)


def smoke_test(executable: Path) -> None:
    """The bundle must start far enough to reject a missing configuration (exit code 2)."""
    # Same minimal environment the Electron supervisor passes. Windows needs SYSTEMROOT for sockets.
    keep = ("PATH", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "TMPDIR", "LANG")
    env = {key: os.environ[key] for key in keep if key in os.environ}
    started = time.monotonic()
    result = subprocess.run([str(executable)], env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=120)
    elapsed = time.monotonic() - started
    if result.returncode != 2:
        sys.stdout.write(result.stdout.decode(errors="replace"))
        raise SystemExit(f"Smoke test failed: expected exit code 2, got {result.returncode}")
    print(f"Smoke test passed: bundle starts and validates config in {elapsed:.1f}s")


def main() -> None:
    prefetch_tiktoken()
    subprocess.run(
        [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "novaris-runtime.spec"],
        cwd=ROOT,
        check=True,
    )
    output = ROOT / "dist" / "novaris-runtime"
    executable = output / ("novaris-runtime.exe" if sys.platform == "win32" else "novaris-runtime")
    size_mb = sum(f.stat().st_size for f in output.rglob("*") if f.is_file()) / 1_000_000
    print(f"Built {executable} ({size_mb:.0f} MB)")
    smoke_test(executable)


if __name__ == "__main__":
    main()
