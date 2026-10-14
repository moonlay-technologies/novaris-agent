"""Approval choices from the chat UI and the tools they have already been granted for."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Any, Literal

logger = logging.getLogger(__name__)

ApprovalChoice = Literal["once", "session", "always", "deny"]
APPROVAL_CHOICES: frozenset[str] = frozenset({"once", "session", "always", "deny"})


class ApprovalStore:
    """Remembers "approve for this session" and "always approve" grants per tool.

    Session grants are kept in memory per thread; "always" grants are saved to
    disk so they survive restarts.
    """

    def __init__(self, path: Path) -> None:
        self._path = path
        self._session: dict[str, set[str]] = {}
        self._always: set[str] = self._load()

    def is_auto_approved(self, thread_id: str | None, tool: str) -> bool:
        if tool in self._always:
            return True
        return thread_id is not None and tool in self._session.get(thread_id, set())

    def record(self, thread_id: str, tools: Iterable[str], choice: ApprovalChoice) -> None:
        if choice == "session":
            self._session.setdefault(thread_id, set()).update(tools)
        elif choice == "always":
            self._always.update(tools)
            self._save()

    def forget_session(self, thread_id: str) -> None:
        self._session.pop(thread_id, None)

    def interrupt_predicate(self, tool: str) -> Callable[[Any], bool]:
        """Builds the HITL `when` callback: interrupt only if the call is not already approved."""

        def should_interrupt(request: Any) -> bool:
            config = getattr(request.runtime, "config", None) or {}
            thread_id = config.get("configurable", {}).get("thread_id")
            return not self.is_auto_approved(thread_id, tool)

        return should_interrupt

    def _load(self) -> set[str]:
        try:
            data = json.loads(self._path.read_text(encoding="utf-8"))
            return {str(tool) for tool in data.get("always", [])}
        except FileNotFoundError:
            return set()
        except (OSError, ValueError):
            logger.warning("Ignoring unreadable approvals file", extra={"path": str(self._path)})
            return set()

    def _save(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._path.with_suffix(".tmp")
        tmp.write_text(json.dumps({"always": sorted(self._always)}, indent=2), encoding="utf-8")
        tmp.replace(self._path)


def choice_to_decision(choice: str) -> dict[str, str]:
    if choice not in APPROVAL_CHOICES:
        raise ValueError(f"Invalid approval choice: {choice}")
    return {"type": "reject"} if choice == "deny" else {"type": "approve"}
