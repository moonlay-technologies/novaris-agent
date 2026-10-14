"""PyInstaller entry point. `novaris_runtime/__main__.py` uses package-relative imports, so it cannot be the script."""

from novaris_runtime.__main__ import main

if __name__ == "__main__":
    main()
