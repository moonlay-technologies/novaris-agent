from __future__ import annotations

import asyncio
import json

import pytest
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus

from fakes import reply
from novaris_runtime.server import RuntimeServer

TOKEN = "s" * 40


@pytest.fixture
async def running(make_harness):
    harness = make_harness([reply("Hello from the runtime.")])
    server = RuntimeServer(TOKEN, {"runtime": "deepagents", "model": "gpt-4o-mini"})
    harness.runtime._emit = server.emit  # route events to WebSocket clients
    server.runtime = harness.runtime
    ws_server = await server.start("127.0.0.1", 0)
    port = next(iter(ws_server.sockets)).getsockname()[1]
    async with ws_server:
        yield server, port


async def test_rejects_a_wrong_token(running):
    _, port = running
    with pytest.raises(InvalidStatus) as excinfo:
        async with connect(f"ws://127.0.0.1:{port}/api/ws?token=wrong"):
            pass
    assert excinfo.value.response.status_code == 401


async def test_rejects_other_paths(running):
    _, port = running
    with pytest.raises(InvalidStatus) as excinfo:
        async with connect(f"ws://127.0.0.1:{port}/other?token={TOKEN}"):
            pass
    assert excinfo.value.response.status_code == 404


async def test_full_chat_round_trip(running):
    _, port = running
    async with connect(f"ws://127.0.0.1:{port}/api/ws?token={TOKEN}") as ws:
        ready = json.loads(await ws.recv())
        assert ready["params"]["type"] == "gateway.ready"

        await ws.send(json.dumps({"jsonrpc": "2.0", "id": 1, "method": "session.create", "params": {}}))
        session_id = json.loads(await ws.recv())["result"]["session_id"]

        await ws.send(
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "prompt.submit", "params": {"session_id": session_id, "text": "hi"}})
        )
        text, saw_ack = "", False
        while True:
            frame = json.loads(await asyncio.wait_for(ws.recv(), timeout=10))
            if frame.get("id") == 2:
                saw_ack = frame["result"] == {"accepted": True}
                continue
            event = frame["params"]
            if event["type"] == "message.delta":
                text += event["payload"]["text"]
            if event["type"] == "session.idle":
                break

    assert saw_ack
    assert text == "Hello from the runtime."


async def test_dispatch_errors(running):
    server, _ = running
    assert (await server.dispatch("not json"))["error"]["code"] == -32700
    assert (await server.dispatch(json.dumps({"id": 1, "method": "nope"})))["error"]["code"] == -32601
    missing = await server.dispatch(json.dumps({"id": 2, "method": "prompt.submit", "params": {}}))
    assert missing["error"]["code"] == -32602
    unknown = await server.dispatch(
        json.dumps({"id": 3, "method": "prompt.submit", "params": {"session_id": "nope", "text": "hi"}})
    )
    assert unknown["error"]["message"] == "Unknown session"
    bad_choice = await server.dispatch(
        json.dumps({"id": 4, "method": "approval.respond", "params": {"session_id": "x", "choice": "maybe"}})
    )
    assert "error" in bad_choice
