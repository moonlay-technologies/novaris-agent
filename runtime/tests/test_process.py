"""Starts the real runtime process against a mock OpenAI-compatible backend proxy."""

from __future__ import annotations

import asyncio
import json
import os
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

import pytest
from websockets.asyncio.client import connect

ACCESS_TOKEN = "user-jwt-1"
REFRESHED_TOKEN = "user-jwt-2"
RUNTIME_TOKEN = "p" * 40


class MockProxy(BaseHTTPRequestHandler):
    requests: list[dict[str, Any]] = []

    def log_message(self, *args: Any) -> None:
        pass

    def do_POST(self) -> None:
        body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        MockProxy.requests.append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body})
        if self.path != "/api/v1/proxy/chat/completions":
            self.send_response(404)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.end_headers()
        base = {"id": "chatcmpl-1", "object": "chat.completion.chunk", "created": 0, "model": body["model"]}
        chunks = [
            {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "content": "Hello"}, "finish_reason": None}]},
            {**base, "choices": [{"index": 0, "delta": {"content": " from the proxy."}, "finish_reason": None}]},
            {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            {**base, "choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}},
        ]
        for chunk in chunks:
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b"data: [DONE]\n\n")


@pytest.fixture
def mock_proxy():
    MockProxy.requests = []
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockProxy)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{server.server_address[1]}"
    server.shutdown()


async def read_ready_port(process: subprocess.Popen[bytes]) -> int:
    loop = asyncio.get_running_loop()
    while True:
        line = await asyncio.wait_for(loop.run_in_executor(None, process.stdout.readline), timeout=60)  # type: ignore[union-attr]
        if not line:
            raise AssertionError(f"runtime exited early with code {process.wait()}")
        text = line.decode().strip()
        if text.startswith("NOVARIS_RUNTIME_READY"):
            return json.loads(text.split(" ", 1)[1])["port"]


async def test_runtime_process_end_to_end(tmp_path: Path, mock_proxy: str):
    policy = {
        "backendBaseUrl": mock_proxy,
        "proxyEndpointUrl": f"{mock_proxy}/api/v1/proxy/chat/completions",
        "policyVersion": "v2",
        "allowedTools": ["file_reader"],
        "workspacePath": str(tmp_path / "ws"),
        "model": "gpt-4o-mini",
        "maxInputTokens": 128000,
        "systemPrompt": "Test.",
    }
    policy_file = tmp_path / "policy.json"
    policy_file.write_text(json.dumps(policy), encoding="utf-8")
    env = {
        **os.environ,
        "NOVARIS_POLICY_FILE": str(policy_file),
        "NOVARIS_ACCESS_TOKEN": ACCESS_TOKEN,
        "NOVARIS_RUNTIME_TOKEN": RUNTIME_TOKEN,
        "NOVARIS_DATA_DIR": str(tmp_path / "data"),
        "NOVARIS_RUNTIME_PORT": "0",
    }
    # Set NOVARIS_RUNTIME_EXE to run this test against a PyInstaller bundle instead of the source tree.
    bundled = os.environ.get("NOVARIS_RUNTIME_EXE")
    process = subprocess.Popen(
        [bundled] if bundled else [sys.executable, "-m", "novaris_runtime"],
        cwd=Path(__file__).resolve().parents[1],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        port = await read_ready_port(process)
        async with connect(f"ws://127.0.0.1:{port}/api/ws?token={RUNTIME_TOKEN}") as ws:
            assert json.loads(await ws.recv())["params"]["type"] == "gateway.ready"
            await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "session.create"}))
            session_id = json.loads(await ws.recv())["result"]["session_id"]
            await ws.send(
                json.dumps({"jsonrpc": "2.0", "id": 2, "method": "prompt.submit", "params": {"session_id": session_id, "text": "hi"}})
            )
            text = ""
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                event = frame.get("params") or {}
                if event.get("type") == "message.delta":
                    text += event["payload"]["text"]
                elif event.get("type") == "error":
                    raise AssertionError(event["payload"])
                elif event.get("type") == "session.idle":
                    break

            # Electron hands over a refreshed JWT on stdin; the next model call must use it.
            process.stdin.write((json.dumps({"type": "access_token", "token": REFRESHED_TOKEN}) + "\n").encode())  # type: ignore[union-attr]
            process.stdin.flush()  # type: ignore[union-attr]
            await asyncio.sleep(0.5)
            await ws.send(
                json.dumps({"jsonrpc": "2.0", "id": 3, "method": "prompt.submit", "params": {"session_id": session_id, "text": "again"}})
            )
            while True:
                frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=60))
                event = frame.get("params") or {}
                if event.get("type") == "error":
                    raise AssertionError(event["payload"])
                if event.get("type") == "session.idle":
                    break

        assert text == "Hello from the proxy."
        request = MockProxy.requests[0]
        assert request["auth"] == f"Bearer {ACCESS_TOKEN}"
        assert request["body"]["model"] == "gpt-4o-mini"
        assert request["body"]["stream"] is True
        assert request["body"]["stream_options"] == {"include_usage": True}
        assert MockProxy.requests[-1]["auth"] == f"Bearer {REFRESHED_TOKEN}"
        assert (tmp_path / "data" / "checkpoints.sqlite").exists()

        # Closing stdin is how Electron (or its death) stops the runtime.
        process.stdin.close()  # type: ignore[union-attr]
        assert await asyncio.wait_for(asyncio.get_running_loop().run_in_executor(None, process.wait), timeout=30) == 0
    finally:
        if process.poll() is None:
            process.kill()
