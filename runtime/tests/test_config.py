from __future__ import annotations

import pytest

from novaris_runtime.config import ConfigError, load_config


def env(policy_path, **extra):
    return {
        "NOVARIS_POLICY_FILE": str(policy_path),
        "NOVARIS_ACCESS_TOKEN": "user-jwt",
        "NOVARIS_RUNTIME_TOKEN": "t" * 40,
        "NOVARIS_DATA_DIR": "/tmp/novaris",
        **extra,
    }


def test_loads_policy_and_derives_proxy_base(write_policy):
    config = load_config(env(write_policy()))

    assert config.access_token.get() == "user-jwt"
    assert config.proxy_base_url == "https://novaris.example.com/api/v1/proxy"
    assert config.web_search_url == "https://novaris.example.com/api/v1/agent-tools/web-search"
    assert config.model == "gpt-4o-mini"
    assert config.max_input_tokens == 64000
    assert config.allowed_tools == ("file_reader", "file_writer", "web_search")
    assert config.port == 0


def test_rejects_proxy_on_another_host(write_policy):
    path = write_policy(proxyEndpointUrl="https://evil.example.com/v1/chat/completions")
    with pytest.raises(ConfigError, match="proxyEndpointUrl"):
        load_config(env(path))


def test_rejects_web_search_on_another_host(write_policy):
    path = write_policy(webSearchEndpointUrl="https://evil.example.com/search")
    with pytest.raises(ConfigError, match="webSearchEndpointUrl"):
        load_config(env(path))


def test_requires_a_strong_runtime_token(write_policy):
    with pytest.raises(ConfigError, match="NOVARIS_RUNTIME_TOKEN"):
        load_config(env(write_policy(), NOVARIS_RUNTIME_TOKEN="short"))


def test_requires_an_access_token(write_policy):
    with pytest.raises(ConfigError, match="NOVARIS_ACCESS_TOKEN"):
        load_config(env(write_policy(), NOVARIS_ACCESS_TOKEN=""))


def test_falls_back_to_defaults_for_older_policies(write_policy):
    path = write_policy(model=None, maxInputTokens=None, webSearchEndpointUrl=None, systemPrompt=None)
    config = load_config(env(path))

    assert config.model == "gpt-4o-mini"
    assert config.max_input_tokens == 128_000
    assert config.web_search_url is None
