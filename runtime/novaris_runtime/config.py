"""Runtime configuration, read from the policy file and environment Electron passes in."""

from __future__ import annotations

import json
import os
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

PROXY_SUFFIX = "/chat/completions"
MIN_RUNTIME_TOKEN_LENGTH = 32


class ConfigError(Exception):
    """Raised when the runtime cannot start with the configuration it was given."""


class AccessToken:
    """The signed-in user's JWT. Electron sends a new one over stdin when it refreshes the session."""

    def __init__(self, value: str) -> None:
        self._value = value
        self._lock = threading.Lock()

    def get(self) -> str:
        with self._lock:
            return self._value

    def set(self, value: str) -> None:
        with self._lock:
            self._value = value


@dataclass(frozen=True)
class RuntimeConfig:
    policy_version: str
    backend_base_url: str
    # OpenAI-compatible base URL; ChatOpenAI appends /chat/completions.
    proxy_base_url: str
    web_search_url: str | None
    model: str
    max_input_tokens: int
    system_prompt: str
    allowed_tools: tuple[str, ...]
    workspace_path: Path
    data_dir: Path
    # Authenticates the AI proxy and web search calls as the signed-in user.
    access_token: AccessToken
    # Shared secret Electron uses to authenticate to the WebSocket server.
    runtime_token: str
    host: str = "127.0.0.1"
    port: int = 0


def load_config(env: Mapping[str, str] | None = None) -> RuntimeConfig:
    env = os.environ if env is None else env

    policy_file = env.get("NOVARIS_POLICY_FILE")
    if not policy_file:
        raise ConfigError("NOVARIS_POLICY_FILE is not set")
    try:
        policy = json.loads(Path(policy_file).read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ConfigError(f"Cannot read runtime policy: {error}") from error

    backend_base_url = _required(policy, "backendBaseUrl").rstrip("/")
    proxy_endpoint_url = _required(policy, "proxyEndpointUrl")
    _require_same_origin(backend_base_url, proxy_endpoint_url, "proxyEndpointUrl")
    proxy_base_url = proxy_endpoint_url.rstrip("/")
    if proxy_base_url.endswith(PROXY_SUFFIX):
        proxy_base_url = proxy_base_url[: -len(PROXY_SUFFIX)]

    web_search_url = policy.get("webSearchEndpointUrl") or None
    if web_search_url:
        _require_same_origin(backend_base_url, web_search_url, "webSearchEndpointUrl")

    access_token = env.get("NOVARIS_ACCESS_TOKEN", "")
    if not access_token:
        raise ConfigError("NOVARIS_ACCESS_TOKEN is not set")

    runtime_token = env.get("NOVARIS_RUNTIME_TOKEN", "")
    if len(runtime_token) < MIN_RUNTIME_TOKEN_LENGTH:
        raise ConfigError("NOVARIS_RUNTIME_TOKEN is missing or too short")

    data_dir = env.get("NOVARIS_DATA_DIR")
    if not data_dir:
        raise ConfigError("NOVARIS_DATA_DIR is not set")

    try:
        port = int(env.get("NOVARIS_RUNTIME_PORT", "0"))
    except ValueError as error:
        raise ConfigError("NOVARIS_RUNTIME_PORT must be a number") from error

    return RuntimeConfig(
        policy_version=str(_required(policy, "policyVersion")),
        backend_base_url=backend_base_url,
        proxy_base_url=proxy_base_url,
        web_search_url=web_search_url,
        model=policy.get("model") or "gpt-4o-mini",
        max_input_tokens=int(policy.get("maxInputTokens") or 128_000),
        system_prompt=policy.get("systemPrompt") or "",
        allowed_tools=tuple(policy.get("allowedTools") or ()),
        workspace_path=Path(_required(policy, "workspacePath")),
        data_dir=Path(data_dir),
        access_token=AccessToken(access_token),
        runtime_token=runtime_token,
        port=port,
    )


def _required(policy: Mapping[str, object], key: str) -> str:
    value = policy.get(key)
    if value in (None, ""):
        raise ConfigError(f"Runtime policy is missing {key}")
    return str(value)


def _require_same_origin(base: str, url: str, name: str) -> None:
    a, b = urlsplit(base), urlsplit(url)
    if (a.scheme, a.netloc) != (b.scheme, b.netloc):
        raise ConfigError(f"{name} must belong to the configured Novaris backend")
