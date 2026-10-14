"""Builds the Deep Agents graph from the runtime policy."""

from __future__ import annotations

from typing import Any

from deepagents import FilesystemMiddleware, create_deep_agent
from deepagents.backends import CompositeBackend, FilesystemBackend
from langchain_core.language_models import BaseChatModel
from langchain_openai import ChatOpenAI
from langgraph.checkpoint.base import BaseCheckpointSaver

from .approvals import ApprovalStore
from .config import RuntimeConfig
from .policy import WRITE_TOOLS, ToolPolicy, build_tool_policy
from .tools import ASK_USER_TOOL, ask_user, make_web_search_tool

MEMORY_ROUTE = "/memories/"
MEMORY_FILE = "/memories/AGENTS.md"
MEMORY_TEMPLATE = "# Notes about this user and workspace\n\n"

RUNTIME_PROMPT = """
## Environment
- The user's workspace folder is mounted at `/`. Paths outside it do not exist.
- `/memories/AGENTS.md` holds your long-term notes. Update it with `edit_file` only when the user asks you to
  remember something; never store secrets there.
- Changes to files need the user's approval. If a change is rejected, do not retry it unless the user asks.
- Use `ask_user` when a request is ambiguous instead of guessing.
"""


def build_model(config: RuntimeConfig) -> BaseChatModel:
    model = ChatOpenAI(
        model=config.model,
        base_url=config.proxy_base_url,
        api_key=config.install_token,
        # The backend proxy only implements Chat Completions.
        use_responses_api=False,
        streaming=True,
        # The proxy records token usage from the final streamed chunk.
        stream_usage=True,
        max_retries=2,
        timeout=120,
    )
    # Summarization triggers from the profile's context size; the policy is authoritative for it.
    model.profile = {**(model.profile or {}), "max_input_tokens": config.max_input_tokens}
    return model


def build_backend(config: RuntimeConfig) -> CompositeBackend:
    memories_dir = config.data_dir / "memories"
    memories_dir.mkdir(parents=True, exist_ok=True)
    memory_file = memories_dir / "AGENTS.md"
    if not memory_file.exists():
        memory_file.write_text(MEMORY_TEMPLATE, encoding="utf-8")

    config.workspace_path.mkdir(parents=True, exist_ok=True)
    return CompositeBackend(
        # virtual_mode keeps every path inside root_dir, blocking `..` and absolute paths.
        default=FilesystemBackend(root_dir=config.workspace_path, virtual_mode=True),
        routes={MEMORY_ROUTE: FilesystemBackend(root_dir=memories_dir, virtual_mode=True)},
    )


def build_interrupt_on(policy: ToolPolicy, approvals: ApprovalStore) -> dict[str, Any]:
    interrupt_on: dict[str, Any] = {
        ASK_USER_TOOL: {"allowed_decisions": ["respond"]},
    }
    if policy.can_write:
        for tool_name in WRITE_TOOLS:
            interrupt_on[tool_name] = {
                "allowed_decisions": ["approve", "reject"],
                "when": approvals.interrupt_predicate(tool_name),
            }
    return interrupt_on


def build_agent(
    config: RuntimeConfig,
    approvals: ApprovalStore,
    checkpointer: BaseCheckpointSaver,
    model: BaseChatModel | None = None,
) -> Any:
    policy = build_tool_policy(config.allowed_tools)
    backend = build_backend(config)

    tools: list[Any] = [ask_user]
    if policy.web_search and config.web_search_url:
        tools.append(make_web_search_tool(config.web_search_url, config.install_token))

    # Replaces the built-in FilesystemMiddleware by name so only the policy's tools are exposed. The
    # general-purpose subagent inherits this replacement, so it gets the same restricted toolset.
    filesystem = FilesystemMiddleware(
        backend=backend,
        tools=list(policy.filesystem_tools),  # type: ignore[arg-type]
        _permissions=policy.permissions,
    )

    return create_deep_agent(
        model=model or build_model(config),
        tools=tools,
        system_prompt=(config.system_prompt + "\n" + RUNTIME_PROMPT).strip(),
        middleware=[filesystem],
        backend=backend,
        permissions=policy.permissions,
        interrupt_on=build_interrupt_on(policy, approvals),
        memory=[MEMORY_FILE],
        checkpointer=checkpointer,
        name="novaris-agent",
    )
