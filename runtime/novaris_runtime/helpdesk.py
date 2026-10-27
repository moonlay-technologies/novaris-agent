"""Self-service helpdesk tools: tickets, access requests and asset requests, filed as the signed-in user.

Every call goes to the backend's `/api/v1/me/*` routes with the user's JWT, so the backend decides the
requester, client and branch; the model only supplies the request details. Tools that submit something
are gated by user approval (see `SUBMIT_TOOLS` in agent.py).
"""

from __future__ import annotations

import logging
from typing import Any, Literal

import httpx
from langchain_core.tools import BaseTool, tool

from .config import AccessToken

logger = logging.getLogger(__name__)

HELPDESK_TIMEOUT_SECONDS = 20.0
ME_PREFIX = "/api/v1/me"

CREATE_TICKET_TOOL = "create_ticket"
REQUEST_ACCESS_TOOL = "request_access"
REQUEST_ASSET_TOOL = "request_asset"


class BackendError(Exception):
    """A request the backend refused or could not serve, worded for the model."""


class MeClient:
    def __init__(self, backend_base_url: str, access_token: AccessToken) -> None:
        self._base_url = backend_base_url.rstrip("/") + ME_PREFIX
        self._access_token = access_token

    async def get(self, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._request("GET", path, params=params)

    async def post(self, path: str, body: dict[str, Any]) -> Any:
        return await self._request("POST", path, json=body)

    async def _request(self, method: str, path: str, **kwargs: Any) -> Any:
        try:
            async with httpx.AsyncClient(timeout=HELPDESK_TIMEOUT_SECONDS) as client:
                response = await client.request(
                    method,
                    self._base_url + path,
                    headers={"Authorization": f"Bearer {self._access_token.get()}"},
                    **kwargs,
                )
        except httpx.HTTPError as error:
            logger.warning("Helpdesk request failed", extra={"path": path, "error": str(error)})
            raise BackendError("The Novaris service is unreachable right now. Try again later.") from error

        if response.is_success:
            return response.json().get("data")
        logger.warning("Helpdesk request refused", extra={"path": path, "status": response.status_code})
        raise BackendError(_describe_refusal(response))


def _describe_refusal(response: httpx.Response) -> str:
    try:
        body = response.json()
    except ValueError:
        body = {}
    message = body.get("error") or body.get("message") or ""
    if isinstance(message, dict):
        message = message.get("message", "")
    details = body.get("errors") or body.get("details") or []
    if isinstance(details, list) and details:
        fields = "; ".join(f"{d.get('path', '')}: {d.get('message', '')}" for d in details if isinstance(d, dict))
        message = f"{message} ({fields})" if message else fields
    if response.status_code == 401:
        return "The user's session has expired; ask them to sign in again."
    if response.status_code == 403:
        return "The user's account is not allowed to do this."
    return f"Request failed (HTTP {response.status_code}): {message or 'no details'}"


def _optional(**fields: Any) -> dict[str, Any]:
    return {key: value for key, value in fields.items() if value not in (None, "")}


def make_ticket_tools(client: MeClient) -> list[BaseTool]:
    @tool(CREATE_TICKET_TOOL)
    async def create_ticket(
        title: str,
        description: str,
        priority: Literal["low", "medium", "high", "urgent"] = "medium",
    ) -> str:
        """File an IT helpdesk ticket for the user (an incident or problem they need IT to fix).

        Write a short title and a description with what happened, when, and what the user already tried.
        Use `urgent` only when the user cannot work at all.
        """
        try:
            ticket = await client.post("/tickets", {"title": title, "description": description, "priority": priority})
        except BackendError as error:
            return str(error)
        return f"Ticket #{ticket.get('id')} created with status {ticket.get('status', 'open')}: {ticket.get('title')}"

    @tool
    async def list_my_tickets(
        status: Literal["open", "in_progress", "waiting", "resolved", "closed"] | None = None,
    ) -> str:
        """List the user's own helpdesk tickets, newest first, optionally filtered by status."""
        try:
            tickets = await client.get("/tickets", params=_optional(status=status))
        except BackendError as error:
            return str(error)
        if not tickets:
            return "The user has no tickets."
        return "\n".join(
            f"#{t.get('id')} [{t.get('status')}, {t.get('priority')}] {t.get('title')}" for t in tickets[:50]
        )

    return [create_ticket, list_my_tickets]


def make_asset_request_tools(client: MeClient) -> list[BaseTool]:
    @tool
    async def list_asset_categories() -> str:
        """List the asset categories (laptops, monitors, ...) the user can request, with their ids."""
        try:
            categories = await client.get("/asset-categories")
        except BackendError as error:
            return str(error)
        if not categories:
            return "No asset categories are set up for this organization."
        return "\n".join(f"{c.get('id')}: {c.get('name')}" for c in categories)

    @tool(REQUEST_ASSET_TOOL)
    async def request_asset(
        category_id: int,
        title: str,
        justification: str,
        quantity: int = 1,
        needed_by: str | None = None,
    ) -> str:
        """Submit a request for a new asset (hardware or equipment) for the user.

        `category_id` must come from `list_asset_categories`. `justification` explains why the user needs it.
        `needed_by` is an optional date in YYYY-MM-DD format.
        """
        body = {"category_id": category_id, "title": title, "justification": justification, "quantity": quantity}
        body.update(_optional(needed_by=needed_by))
        try:
            request = await client.post("/asset-requests", body)
        except BackendError as error:
            return str(error)
        return f"Asset request #{request.get('id')} submitted with status {request.get('status', 'pending')}."

    return [list_asset_categories, request_asset]


def make_access_request_tools(client: MeClient) -> list[BaseTool]:
    @tool
    async def list_access_systems() -> str:
        """List the systems and applications the user can request access to, with their ids."""
        try:
            systems = await client.get("/access-systems")
        except BackendError as error:
            return str(error)
        if not systems:
            return "No systems are open for access requests in this organization."
        return "\n".join(f"{s.get('id')}: {s.get('name')} ({s.get('product')})" for s in systems)

    @tool(REQUEST_ACCESS_TOOL)
    async def request_access(
        system_id: int,
        request_type: Literal["new", "change", "termination"],
        access_level: str,
        justification: str,
        start_date: str,
        supervisor_name: str,
        supervisor_title: str,
        end_date: str | None = None,
        notes: str | None = None,
    ) -> str:
        """Submit a request for access to a system or application for the user.

        `system_id` must come from `list_access_systems`. `request_type` is `new` for new access, `change`
        to change existing access, or `termination` to remove it. `access_level` is the role or rights
        needed (e.g. "read only"). Dates are YYYY-MM-DD. The supervisor is the user's direct supervisor,
        who approves the request; ask the user for their name and job title instead of guessing.
        """
        body = {
            "license_id": system_id,
            "request_type": {"new": "baru", "change": "perubahan", "termination": "terminasi"}[request_type],
            "access_level_requested": access_level,
            "business_justification": justification,
            "access_start_date": start_date,
            "direct_supervisor_name": supervisor_name,
            "direct_supervisor_title": supervisor_title,
        }
        body.update(_optional(access_end_date=end_date, notes=notes))
        try:
            request = await client.post("/access-requests", body)
        except BackendError as error:
            return str(error)
        return (
            f"Access request #{request.get('id')} submitted for {request.get('target_system', 'the system')} "
            f"with status {request.get('status', 'submitted')}."
        )

    return [list_access_systems, request_access]
