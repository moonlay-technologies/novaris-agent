"""Chat sessions: runs the agent, streams events, and pauses for approvals and questions."""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from typing import Any

from langgraph.types import Command

from .approvals import ApprovalStore, choice_to_decision
from .streaming import Event, StreamTranslator, describe_action
from .tools import ASK_USER_TOOL

logger = logging.getLogger(__name__)

EmitFn = Callable[[str, str, dict[str, Any]], Awaitable[None]]
MAX_MESSAGE_LENGTH = 20_000
RECURSION_LIMIT = 200


class SessionError(Exception):
    """A request the client sent that cannot be honoured in the current state."""


@dataclass
class PendingAction:
    interrupt_id: str
    index: int
    name: str
    args: dict[str, Any]
    decision: dict[str, Any] | None = None

    @property
    def is_question(self) -> bool:
        return self.name == ASK_USER_TOOL

    @property
    def clarify_id(self) -> str:
        return f"{self.interrupt_id}:{self.index}"


@dataclass
class Session:
    id: str
    task: asyncio.Task[None] | None = None
    pending: list[PendingAction] = field(default_factory=list)

    @property
    def busy(self) -> bool:
        return self.task is not None and not self.task.done()


class ChatRuntime:
    """Transport-independent chat logic. The WebSocket server is a thin layer over this."""

    def __init__(self, agent: Any, approvals: ApprovalStore, emit: EmitFn) -> None:
        self._agent = agent
        self._approvals = approvals
        self._emit = emit
        self._sessions: dict[str, Session] = {}

    def create_session(self, session_id: str | None = None) -> str:
        # Reusing an ID reattaches to that thread's saved history.
        session_id = session_id or uuid.uuid4().hex
        self._sessions.setdefault(session_id, Session(session_id))
        return session_id

    def submit(self, session_id: str, text: str) -> None:
        session = self._session(session_id)
        text = text.strip()
        if not text or len(text) > MAX_MESSAGE_LENGTH:
            raise SessionError("Message must contain 1-20,000 characters")
        if session.busy:
            raise SessionError("The assistant is still working on the previous message")
        if session.pending:
            raise SessionError("Answer the pending request before sending a new message")
        self._start(session, {"messages": [{"role": "user", "content": text}]})

    def respond_approval(self, session_id: str, choice: str) -> None:
        session = self._session(session_id)
        decision = choice_to_decision(choice)
        approvals = [a for a in session.pending if not a.is_question and a.decision is None]
        if not approvals:
            raise SessionError("There is no pending approval request")
        for action in approvals:
            action.decision = decision
        if choice in ("session", "always"):
            self._approvals.record(session.id, {a.name for a in approvals}, choice)  # type: ignore[arg-type]
        self._resume_if_decided(session)

    def respond_clarify(self, clarify_id: str, response: str) -> None:
        for session in self._sessions.values():
            for action in session.pending:
                if action.is_question and action.clarify_id == clarify_id and action.decision is None:
                    action.decision = {"type": "respond", "message": response.strip() or "(no answer)"}
                    self._resume_if_decided(session)
                    return
        raise SessionError("Unknown or already answered clarification request")

    async def close(self) -> None:
        tasks = [s.task for s in self._sessions.values() if s.busy]
        for task in tasks:
            task.cancel()  # type: ignore[union-attr]
        await asyncio.gather(*tasks, return_exceptions=True)  # type: ignore[arg-type]

    def _session(self, session_id: str) -> Session:
        session = self._sessions.get(session_id)
        if session is None:
            raise SessionError("Unknown session")
        return session

    def _resume_if_decided(self, session: Session) -> None:
        if any(a.decision is None for a in session.pending):
            return
        resume: dict[str, dict[str, Any]] = {}
        for action in sorted(session.pending, key=lambda a: (a.interrupt_id, a.index)):
            resume.setdefault(action.interrupt_id, {"decisions": []})["decisions"].append(action.decision)
        session.pending = []
        self._start(session, Command(resume=resume))

    def _start(self, session: Session, agent_input: Any) -> None:
        session.task = asyncio.create_task(self._run(session, agent_input), name=f"session-{session.id}")

    async def _run(self, session: Session, agent_input: Any) -> None:
        config = {"configurable": {"thread_id": session.id}, "recursion_limit": RECURSION_LIMIT}
        translator = StreamTranslator()
        try:
            async for namespace, mode, data in self._agent.astream(
                agent_input, config, stream_mode=["messages", "updates"], subgraphs=True
            ):
                for event in translator.feed(namespace, mode, data):
                    await self._send(session, event)
            for event in translator.finish():
                await self._send(session, event)

            state = await self._agent.aget_state(config, subgraphs=True)
            interrupts = _collect_interrupts(state)
            if interrupts:
                await self._ask(session, interrupts)
            else:
                await self._send(session, Event("session.idle"))
        except asyncio.CancelledError:
            raise
        except Exception as error:  # noqa: BLE001 - every failure must reach the user, not kill the runtime
            logger.exception("Agent run failed", extra={"session_id": session.id})
            for event in translator.finish():
                await self._send(session, event)
            await self._send(session, Event("error", {"message": user_facing_error(error)}))
            await self._send(session, Event("session.idle"))

    async def _ask(self, session: Session, interrupts: list[Any]) -> None:
        session.pending = [
            PendingAction(interrupt.id, i, action["name"], action.get("args") or {})
            for interrupt in interrupts
            for i, action in enumerate((interrupt.value or {}).get("action_requests", []))
        ]
        approvals = [a for a in session.pending if not a.is_question]
        if approvals:
            lines = "\n".join(f"- {describe_action({'name': a.name, 'args': a.args})}" for a in approvals)
            await self._send(
                session,
                Event(
                    "approval.request",
                    {
                        "message": f"The assistant wants to make these changes:\n{lines}",
                        "actions": [{"name": a.name, "args": _preview_args(a.args)} for a in approvals],
                        "choices": ["once", "session", "always", "deny"],
                    },
                ),
            )
        for question in (a for a in session.pending if a.is_question):
            await self._send(
                session,
                Event("clarify.request", {"clarify_id": question.clarify_id, "question": question.args.get("question", "")}),
            )

    async def _send(self, session: Session, event: Event) -> None:
        await self._emit(event.type, session.id, event.payload)


def _collect_interrupts(state: Any) -> list[Any]:
    """Interrupts raised anywhere in the graph, including inside subagents."""
    found: dict[str, Any] = {interrupt.id: interrupt for interrupt in getattr(state, "interrupts", ()) or ()}
    for task in getattr(state, "tasks", ()) or ():
        for interrupt in task.interrupts or ():
            found.setdefault(interrupt.id, interrupt)
        if task.state is not None and hasattr(task.state, "tasks"):
            for interrupt in _collect_interrupts(task.state):
                found.setdefault(interrupt.id, interrupt)
    return list(found.values())


def _preview_args(args: dict[str, Any], limit: int = 2000) -> dict[str, Any]:
    """Tool args for the approval UI, with long file contents cut short."""
    preview: dict[str, Any] = {}
    for key, value in args.items():
        if isinstance(value, str) and len(value) > limit:
            value = value[:limit] + f"\n... ({len(value) - limit} more characters)"
        preview[key] = value
    return preview


def user_facing_error(error: Exception) -> str:
    status = getattr(error, "status_code", None)
    if status == 401:
        return "Your session is no longer valid. Sign in again on the Account page."
    if status == 403:
        return "Your account is not allowed to use the AI service. Contact your administrator."
    if status == 429:
        return "Today's AI usage limit has been reached. It resets at midnight."
    if status is not None and status >= 500:
        return "The AI service is unavailable right now. Try again in a moment."
    if "Connection" in type(error).__name__ or "Timeout" in type(error).__name__:
        return "Cannot reach the Novaris server. Check the network connection and try again."
    return "Something went wrong while answering. Try again."
