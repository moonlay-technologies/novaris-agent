"""Entry point: `python -m novaris_runtime` (or the bundled `novaris-runtime` executable).

Electron starts this process with the environment documented in `config.py`, waits
for the `NOVARIS_RUNTIME_READY {"port": N}` line on stdout, then connects over
WebSocket. The process exits when stdin closes, so it never outlives Electron.
Electron also writes `{"type": "access_token", "token": "..."}` lines to stdin when it
refreshes the signed-in user's session.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .config import AccessToken

READY_PREFIX = "NOVARIS_RUNTIME_READY"


class JsonLogFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        entry = {"level": record.levelname.lower(), "logger": record.name, "message": record.getMessage()}
        if record.exc_info:
            entry["exception"] = self.formatException(record.exc_info)
        return json.dumps(entry)


def configure_logging() -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonLogFormatter())
    logging.basicConfig(level=os.environ.get("NOVARIS_LOG_LEVEL", "INFO").upper(), handlers=[handler], force=True)
    for noisy in ("httpx", "httpcore", "websockets", "openai"):
        logging.getLogger(noisy).setLevel(logging.WARNING)


def configure_frozen_environment() -> None:
    """Points libraries at data files bundled by PyInstaller so the runtime works offline."""
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        os.environ.setdefault("TIKTOKEN_CACHE_DIR", str(Path(bundle_dir) / "tiktoken_cache"))


def watch_stdin(loop: asyncio.AbstractEventLoop, stop: asyncio.Event, access_token: AccessToken) -> None:
    """Applies access token updates from the parent; stops the runtime when it closes our stdin (or dies)."""
    logger = logging.getLogger("novaris_runtime")

    def wait() -> None:
        try:
            for line in sys.stdin.buffer:
                try:
                    message = json.loads(line)
                except ValueError:
                    continue
                if isinstance(message, dict) and message.get("type") == "access_token" and message.get("token"):
                    access_token.set(str(message["token"]))
                    logger.info("Access token updated")
        except (OSError, ValueError):
            pass
        loop.call_soon_threadsafe(stop.set)

    if sys.stdin is not None and not sys.stdin.isatty():
        threading.Thread(target=wait, name="stdin-watch", daemon=True).start()


async def run() -> int:
    from langgraph.checkpoint.sqlite.aio import AsyncSqliteSaver

    from .agent import build_agent
    from .approvals import ApprovalStore
    from .config import ConfigError, load_config
    from .server import RuntimeServer
    from .session import ChatRuntime

    logger = logging.getLogger("novaris_runtime")
    try:
        config = load_config()
    except ConfigError as error:
        logger.error("Invalid runtime configuration: %s", error)
        return 2

    config.data_dir.mkdir(parents=True, exist_ok=True)
    loop = asyncio.get_running_loop()
    stop = asyncio.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, stop.set)
        except (NotImplementedError, RuntimeError):
            signal.signal(sig, lambda *_: loop.call_soon_threadsafe(stop.set))
    watch_stdin(loop, stop, config.access_token)

    status = {"runtime": "deepagents", "model": config.model, "policy_version": config.policy_version}
    server = RuntimeServer(config.runtime_token, status)
    ws_server = await server.start(config.host, config.port)
    port = next(iter(ws_server.sockets)).getsockname()[1]

    async with AsyncSqliteSaver.from_conn_string(str(config.data_dir / "checkpoints.sqlite")) as checkpointer:
        approvals = ApprovalStore(config.data_dir / "approvals.json")
        agent = build_agent(config, approvals, checkpointer)
        server.runtime = ChatRuntime(agent, approvals, server.emit)

        print(f"{READY_PREFIX} {json.dumps({'port': port})}", flush=True)
        logger.info("Runtime ready on 127.0.0.1:%s (model %s)", port, config.model)

        async with ws_server:
            await stop.wait()
            logger.info("Runtime stopping")
            await server.runtime.close()
    return 0


def main() -> None:
    configure_frozen_environment()
    configure_logging()
    sys.exit(asyncio.run(run()))


if __name__ == "__main__":
    main()
