"""Loopback WebSocket server speaking the JSON-RPC protocol of Hermes's gateway.

Keeping the protocol means Electron's chat client and UI work unchanged:
requests `session.create`, `prompt.submit`, `approval.respond`, `clarify.respond`;
events `gateway.ready`, `message.start|delta|complete`, `reasoning.delta`,
`approval.request`, `clarify.request`, `tool.result`, `session.idle`, `error`.
"""

from __future__ import annotations

import hmac
import json
import logging
from collections.abc import Awaitable, Callable
from http import HTTPStatus
from typing import Any
from urllib.parse import parse_qs, urlsplit

from websockets.asyncio.server import Server, ServerConnection, serve
from websockets.exceptions import ConnectionClosed
from websockets.http11 import Request, Response

from .session import ChatRuntime, SessionError

logger = logging.getLogger(__name__)

WS_PATH = "/api/ws"
MAX_FRAME_BYTES = 256 * 1024

# JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
APP_ERROR = -32000


class RuntimeServer:
    def __init__(self, runtime_token: str, status: dict[str, Any]) -> None:
        self._token = runtime_token
        self._status = status
        self._connections: set[ServerConnection] = set()
        self.runtime: ChatRuntime | None = None

    async def emit(self, event_type: str, session_id: str, payload: dict[str, Any]) -> None:
        frame = json.dumps(
            {"jsonrpc": "2.0", "method": "event", "params": {"type": event_type, "session_id": session_id, "payload": payload}}
        )
        for connection in list(self._connections):
            try:
                await connection.send(frame)
            except ConnectionClosed:
                self._connections.discard(connection)

    async def start(self, host: str, port: int) -> Server:
        return await serve(
            self._handle,
            host,
            port,
            process_request=self._authorize,
            max_size=MAX_FRAME_BYTES,
        )

    def _authorize(self, connection: ServerConnection, request: Request) -> Response | None:
        url = urlsplit(request.path)
        if url.path != WS_PATH:
            return connection.respond(HTTPStatus.NOT_FOUND, "Not found\n")
        token = parse_qs(url.query).get("token", [""])[0]
        if not hmac.compare_digest(token.encode(), self._token.encode()):
            logger.warning("Rejected WebSocket connection with an invalid token")
            return connection.respond(HTTPStatus.UNAUTHORIZED, "Unauthorized\n")
        return None

    async def _handle(self, connection: ServerConnection) -> None:
        self._connections.add(connection)
        try:
            await connection.send(
                json.dumps({"jsonrpc": "2.0", "method": "event", "params": {"type": "gateway.ready", "payload": self._status}})
            )
            async for raw in connection:
                response = await self.dispatch(raw)
                if response is not None:
                    await connection.send(json.dumps(response))
        except ConnectionClosed:
            pass
        finally:
            self._connections.discard(connection)

    async def dispatch(self, raw: str | bytes) -> dict[str, Any] | None:
        try:
            frame = json.loads(raw)
        except ValueError:
            return _error(None, PARSE_ERROR, "Invalid JSON")
        if not isinstance(frame, dict) or not isinstance(frame.get("method"), str):
            return _error(frame.get("id") if isinstance(frame, dict) else None, INVALID_REQUEST, "Invalid request")

        request_id = frame.get("id")
        params = frame.get("params") or {}
        handler = self._handlers().get(frame["method"])
        if handler is None:
            return _error(request_id, METHOD_NOT_FOUND, f"Unknown method {frame['method']}")
        if not isinstance(params, dict):
            return _error(request_id, INVALID_PARAMS, "params must be an object")
        try:
            result = await handler(params)
        except KeyError as error:
            return _error(request_id, INVALID_PARAMS, f"Missing parameter {error}")
        except (SessionError, ValueError, TypeError) as error:
            return _error(request_id, APP_ERROR, str(error) or type(error).__name__)
        return None if request_id is None else {"jsonrpc": "2.0", "id": request_id, "result": result}

    def _handlers(self) -> dict[str, Callable[[dict[str, Any]], Awaitable[Any]]]:
        return {
            "runtime.status": self._runtime_status,
            "session.create": self._session_create,
            "prompt.submit": self._prompt_submit,
            "approval.respond": self._approval_respond,
            "clarify.respond": self._clarify_respond,
        }

    def _chat(self) -> ChatRuntime:
        if self.runtime is None:
            raise SessionError("The agent is still starting")
        return self.runtime

    async def _runtime_status(self, _params: dict[str, Any]) -> dict[str, Any]:
        return {**self._status, "ready": self.runtime is not None}

    async def _session_create(self, params: dict[str, Any]) -> dict[str, Any]:
        session_id = params.get("session_id")
        if session_id is not None and (not isinstance(session_id, str) or not 8 <= len(session_id) <= 64):
            raise ValueError("Invalid session_id")
        return {"session_id": self._chat().create_session(session_id)}

    async def _prompt_submit(self, params: dict[str, Any]) -> dict[str, Any]:
        self._chat().submit(str(params["session_id"]), str(params["text"]))
        return {"accepted": True}

    async def _approval_respond(self, params: dict[str, Any]) -> dict[str, Any]:
        self._chat().respond_approval(str(params["session_id"]), str(params["choice"]))
        return {"accepted": True}

    async def _clarify_respond(self, params: dict[str, Any]) -> dict[str, Any]:
        self._chat().respond_clarify(str(params["clarify_id"]), str(params.get("response", "")))
        return {"accepted": True}


def _error(request_id: Any, code: int, message: str) -> dict[str, Any]:
    return {"jsonrpc": "2.0", "id": request_id, "error": {"code": code, "message": message}}
