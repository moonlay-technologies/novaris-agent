"""A scripted chat model that streams text and tool calls like a real provider."""

from __future__ import annotations

from collections.abc import Iterator, Sequence
from typing import Any

from langchain_core.callbacks import CallbackManagerForLLMRun
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, BaseMessage
from langchain_core.outputs import ChatGeneration, ChatGenerationChunk, ChatResult
from pydantic import Field


def reply(text: str = "", tool_calls: Sequence[dict[str, Any]] = ()) -> AIMessage:
    """One scripted model turn. Tool calls are `{"name": ..., "args": {...}}`."""
    calls = [{"id": f"call_{i}_{c['name']}", "name": c["name"], "args": c["args"]} for i, c in enumerate(tool_calls)]
    return AIMessage(content=text, tool_calls=calls)


class ScriptedChatModel(BaseChatModel):
    script: list[AIMessage]
    calls: list[list[BaseMessage]] = Field(default_factory=list)
    bound_tool_names: list[list[str]] = Field(default_factory=list)
    position: int = 0

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def bind_tools(self, tools: Any, **kwargs: Any) -> ScriptedChatModel:
        self.bound_tool_names.append([getattr(t, "name", None) or t.get("name") for t in tools])
        return self

    def _next(self, messages: list[BaseMessage]) -> AIMessage:
        self.calls.append(list(messages))
        if self.position >= len(self.script):
            return AIMessage(content="(script exhausted)")
        message = self.script[self.position]
        self.position += 1
        return message

    def _generate(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> ChatResult:
        return ChatResult(generations=[ChatGeneration(message=self._next(messages))])

    def _stream(
        self,
        messages: list[BaseMessage],
        stop: list[str] | None = None,
        run_manager: CallbackManagerForLLMRun | None = None,
        **kwargs: Any,
    ) -> Iterator[ChatGenerationChunk]:
        message = self._next(messages)
        words = str(message.content).split(" ") if message.content else []
        for i, word in enumerate(words):
            token = word if i == 0 else " " + word
            chunk = ChatGenerationChunk(message=AIMessageChunk(content=token))
            if run_manager:
                run_manager.on_llm_new_token(token, chunk=chunk)
            yield chunk
        if message.tool_calls:
            yield ChatGenerationChunk(
                message=AIMessageChunk(
                    content="",
                    tool_call_chunks=[
                        {"id": c["id"], "name": c["name"], "args": __import__("json").dumps(c["args"]), "index": i}
                        for i, c in enumerate(message.tool_calls)
                    ],
                )
            )
