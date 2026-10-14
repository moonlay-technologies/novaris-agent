# PyInstaller spec for the bundled Novaris agent runtime. Build with `python build.py`.
# One-folder output (dist/novaris-runtime/): faster start than one-file and easier to sign.
import os

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

hiddenimports = [
    *collect_submodules("deepagents"),
    *collect_submodules("langgraph.checkpoint.sqlite"),
    # init_chat_model and middleware import provider packages lazily.
    *collect_submodules("langchain_openai"),
    *collect_submodules("novaris_runtime"),
    "aiosqlite",
]

datas = [
    *collect_data_files("langchain_openai"),
    *collect_data_files("deepagents"),
]

# Optional offline token encodings prepared by build.py; see configure_frozen_environment().
if os.path.isdir("build/tiktoken_cache"):
    datas.append(("build/tiktoken_cache", "tiktoken_cache"))

a = Analysis(
    ["entry.py"],
    pathex=["."],
    hiddenimports=hiddenimports,
    datas=datas,
    # Never ship test or notebook tooling.
    excludes=["pytest", "IPython", "matplotlib", "tkinter"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="novaris-runtime",
    console=True,  # stdout/stdin are the supervisor's control channel; Electron hides the window.
    codesign_identity=os.environ.get("NOVARIS_MAC_SIGN_IDENTITY") or None,
    entitlements_file=os.environ.get("NOVARIS_MAC_ENTITLEMENTS") or None,
)
coll = COLLECT(exe, a.binaries, a.datas, name="novaris-runtime")
