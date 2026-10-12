from __future__ import annotations

import json
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from fakes import ScriptedChatModel
from novaris_runtime.agent import build_agent
from novaris_runtime.approvals import ApprovalStore
from novaris_runtime.config import RuntimeConfig
from novaris_runtime.session import ChatRuntime


@pytest.fixture
def runtime_config(tmp_path: Path) -> RuntimeConfig:
    return RuntimeConfig(
        install_id=1,
        policy_version="v2",
        backend_base_url="http://localhost:3000",
        proxy_base_url="http://localhost:3000/api/v1/proxy",
        web_search_url="http://localhost:3000/api/v1/agent-tools/web-search",
        model="gpt-4o-mini",
        max_input_tokens=128_000,
        system_prompt="You are a test assistant.",
        allowed_tools=("file_reader", "file_writer", "web_search"),
        workspace_path=tmp_path / "workspace",
        data_dir=tmp_path / "data",
        install_token="install-token",
        runtime_token="r" * 40,
    )


class Harness:
    """A ChatRuntime wired to a scripted model, recording every emitted event."""

    def __init__(self, config: RuntimeConfig, model: ScriptedChatModel) -> None:
        self.config = config
        self.model = model
        self.events: list[dict[str, Any]] = []
        self.approvals = ApprovalStore(config.data_dir / "approvals.json")
        agent = build_agent(config, self.approvals, InMemorySaver(), model=model)
        self.runtime = ChatRuntime(agent, self.approvals, self._emit)

    async def _emit(self, event_type: str, session_id: str, payload: dict[str, Any]) -> None:
        self.events.append({"type": event_type, "session_id": session_id, "payload": payload})

    async def wait_idle(self, session_id: str) -> None:
        task = self.runtime._sessions[session_id].task
        if task is not None:
            await task

    def types(self) -> list[str]:
        return [e["type"] for e in self.events]

    def last(self, event_type: str) -> dict[str, Any]:
        return next(e for e in reversed(self.events) if e["type"] == event_type)

    def text(self) -> str:
        return "".join(e["payload"]["text"] for e in self.events if e["type"] == "message.delta")


@pytest.fixture
def make_harness(runtime_config: RuntimeConfig) -> Callable[..., Harness]:
    def factory(script: list[Any], **overrides: Any) -> Harness:
        config = runtime_config
        if overrides:
            config = RuntimeConfig(**{**runtime_config.__dict__, **overrides})
        return Harness(config, ScriptedChatModel(script=script))

    return factory


@pytest.fixture
def write_policy(tmp_path: Path) -> Callable[..., Path]:
    def factory(**fields: Any) -> Path:
        policy = {
            "installId": 7,
            "backendBaseUrl": "https://novaris.example.com",
            "proxyEndpointUrl": "https://novaris.example.com/api/v1/proxy/chat/completions",
            "policyVersion": "v2",
            "allowedTools": ["file_reader", "file_writer", "web_search"],
            "workspacePath": str(tmp_path / "ws"),
            "model": "gpt-4o-mini",
            "maxInputTokens": 64000,
            "systemPrompt": "Be helpful.",
            "webSearchEndpointUrl": "https://novaris.example.com/api/v1/agent-tools/web-search",
            **fields,
        }
        path = tmp_path / "runtime-policy.json"
        path.write_text(json.dumps(policy), encoding="utf-8")
        return path

    return factory
