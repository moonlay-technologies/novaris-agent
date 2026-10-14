"""Maps the backend's allowed-tool names onto Deep Agents tools and permission rules."""

from __future__ import annotations

import logging
from collections.abc import Iterable
from dataclasses import dataclass, field

from deepagents import FilesystemPermission

logger = logging.getLogger(__name__)

READ_TOOLS: tuple[str, ...] = ("ls", "read_file", "glob", "grep")
WRITE_TOOLS: tuple[str, ...] = ("write_file", "edit_file", "delete")
KNOWN_POLICY_TOOLS = frozenset({"file_reader", "file_writer", "web_search"})


@dataclass(frozen=True)
class ToolPolicy:
    # Built-in filesystem tools the model may see. Never includes `execute`.
    filesystem_tools: tuple[str, ...]
    # Hard deny rules, enforced even if the model calls a tool it was not shown.
    permissions: list[FilesystemPermission] = field(default_factory=list)
    web_search: bool = False

    @property
    def can_write(self) -> bool:
        return any(tool in self.filesystem_tools for tool in WRITE_TOOLS)


def build_tool_policy(allowed_tools: Iterable[str]) -> ToolPolicy:
    allowed = set(allowed_tools)
    for unknown in sorted(allowed - KNOWN_POLICY_TOOLS):
        logger.warning("Ignoring unknown tool in runtime policy", extra={"tool": unknown})

    filesystem_tools: list[str] = []
    permissions: list[FilesystemPermission] = []

    if "file_reader" in allowed:
        filesystem_tools.extend(READ_TOOLS)
    else:
        # FilesystemMiddleware requires read_file to exist; the deny rule makes every call fail.
        filesystem_tools.append("read_file")
        permissions.append(FilesystemPermission(operations=["read"], paths=["/**"], mode="deny"))

    if "file_writer" in allowed:
        filesystem_tools.extend(WRITE_TOOLS)
    else:
        permissions.append(FilesystemPermission(operations=["write"], paths=["/**"], mode="deny"))

    return ToolPolicy(
        filesystem_tools=tuple(filesystem_tools),
        permissions=permissions,
        web_search="web_search" in allowed,
    )
