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
from .helpdesk import (
    CREATE_TICKET_TOOL,
    REQUEST_ACCESS_TOOL,
    REQUEST_ASSET_TOOL,
    MeClient,
    make_access_request_tools,
    make_asset_request_tools,
    make_ticket_tools,
)
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
- Tickets, access requests and asset requests are filed as the user and need their approval. Collect the details
  first (ask for anything you do not know, such as their supervisor), and look up ids with the `list_*` tools.
"""


def build_model(config: RuntimeConfig) -> BaseChatModel:
    model = ChatOpenAI(
        model=config.model,
        base_url=config.proxy_base_url,
        # Read on every request so a refreshed JWT is used without restarting the runtime.
        api_key=config.access_token.get,
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


def submit_tools(policy: ToolPolicy) -> dict[str, bool]:
    """Tools that file something with the backend as the user, so they need the user's approval."""
    return {
        CREATE_TICKET_TOOL: policy.create_ticket,
        REQUEST_ACCESS_TOOL: policy.request_access,
        REQUEST_ASSET_TOOL: policy.request_asset,
    }


def build_interrupt_on(policy: ToolPolicy, approvals: ApprovalStore) -> dict[str, Any]:
    interrupt_on: dict[str, Any] = {
        ASK_USER_TOOL: {"allowed_decisions": ["respond"]},
    }
    approval_tools = [name for name, enabled in submit_tools(policy).items() if enabled]
    if policy.can_write:
        approval_tools.extend(WRITE_TOOLS)
    for tool_name in approval_tools:
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
        tools.append(make_web_search_tool(config.web_search_url, config.access_token))
    me_client = MeClient(config.backend_base_url, config.access_token)
    if policy.create_ticket:
        tools.extend(make_ticket_tools(me_client))
    if policy.request_access:
        tools.extend(make_access_request_tools(me_client))
    if policy.request_asset:
        tools.extend(make_asset_request_tools(me_client))

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
