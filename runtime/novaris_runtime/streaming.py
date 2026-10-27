"""Translates LangGraph stream chunks into the chat protocol's events."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

from langchain_core.messages import AIMessageChunk, ToolMessage

from .tools import ASK_USER_TOOL

MODEL_NODE = "model"


@dataclass
class Event:
    type: str
    payload: dict[str, Any] = field(default_factory=dict)


class StreamTranslator:
    """Stateful translator for one run. Only the main agent's output reaches the user;
    subagent work shows up as the `task` tool result instead."""

    def __init__(self) -> None:
        self._message_id: str | None = None

    def feed(self, namespace: tuple[str, ...], mode: str, data: Any) -> Iterator[Event]:
        if namespace:
            return
        if mode == "messages":
            message, metadata = data
            if isinstance(message, AIMessageChunk) and metadata.get("langgraph_node") == MODEL_NODE:
                yield from self._model_chunk(message)
            elif isinstance(message, ToolMessage) and message.name != ASK_USER_TOOL:
                yield Event("tool.result", {"name": message.name, "status": message.status or "success"})
        elif mode == "updates" and MODEL_NODE in data:
            yield from self.finish()

    def finish(self) -> Iterator[Event]:
        if self._message_id is not None:
            yield Event("message.complete", {"message_id": self._message_id})
            self._message_id = None

    def _model_chunk(self, chunk: AIMessageChunk) -> Iterator[Event]:
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        for block in chunk.content_blocks:
            if block.get("type") == "text" and block.get("text"):
                text_parts.append(block["text"])
            elif block.get("type") == "reasoning" and block.get("reasoning"):
                reasoning_parts.append(block["reasoning"])

        if not text_parts and not reasoning_parts:
            return
        if self._message_id is None:
            self._message_id = chunk.id or "message"
            yield Event("message.start", {"message_id": self._message_id})
        if reasoning_parts:
            yield Event("reasoning.delta", {"text": "".join(reasoning_parts)})
        if text_parts:
            yield Event("message.delta", {"text": "".join(text_parts)})


def describe_action(action: dict[str, Any]) -> str:
    """One readable line for an approval prompt, e.g. `write_file /notes/todo.md`."""
    args = action.get("args") or {}
    target = args.get("file_path") or args.get("path") or args.get("title") or ""
    if not target and "system_id" in args:
        target = f"system {args['system_id']}: {args.get('access_level', '')}".strip()
    return f"{action.get('name', 'tool')} {target}".strip()
