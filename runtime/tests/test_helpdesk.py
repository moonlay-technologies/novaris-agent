from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from fakes import reply
from novaris_runtime import helpdesk
from novaris_runtime.policy import build_tool_policy

HELPDESK_TOOLS = ("file_reader", "create_ticket", "request_access", "request_asset")
TICKET = {
    "name": "create_ticket",
    "args": {"title": "VPN down", "description": "Cannot connect since 9am", "priority": "high"},
}


@pytest.fixture
def backend(monkeypatch):
    """Routes the helpdesk tools' HTTP calls to a fake backend and records them."""
    calls: list[dict[str, Any]] = []
    responses: dict[tuple[str, str], tuple[int, Any]] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content) if request.content else None
        calls.append(
            {
                "method": request.method,
                "path": request.url.path,
                "params": dict(request.url.params),
                "body": body,
                "auth": request.headers.get("authorization"),
            }
        )
        status, payload = responses.get((request.method, request.url.path), (404, {"error": "Not found"}))
        return httpx.Response(status, json=payload)

    real_client = httpx.AsyncClient

    def client_factory(**kwargs: Any) -> httpx.AsyncClient:
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(helpdesk.httpx, "AsyncClient", client_factory)

    class Backend:
        def __init__(self) -> None:
            self.calls = calls

        def respond(self, method: str, path: str, status: int, payload: Any) -> None:
            responses[(method, "/api/v1/me" + path)] = (status, payload)

    return Backend()


def test_policy_flags_follow_allowed_tools():
    policy = build_tool_policy(HELPDESK_TOOLS)

    assert policy.create_ticket and policy.request_access and policy.request_asset
    assert not build_tool_policy(["file_reader"]).create_ticket


async def test_helpdesk_tools_are_hidden_unless_allowed(make_harness):
    harness = make_harness([reply("hello")], allowed_tools=("file_reader",))
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "hi")
    await harness.wait_idle(session)

    seen = set(harness.model.bound_tool_names[0])
    assert not seen & {"create_ticket", "list_my_tickets", "request_access", "request_asset", "list_access_systems"}


async def test_helpdesk_tools_are_visible_when_allowed(make_harness):
    harness = make_harness([reply("hello")], allowed_tools=HELPDESK_TOOLS)
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "hi")
    await harness.wait_idle(session)

    seen = set(harness.model.bound_tool_names[0])
    assert {
        "create_ticket",
        "list_my_tickets",
        "request_access",
        "list_access_systems",
        "request_asset",
        "list_asset_categories",
    } <= seen


async def test_ticket_is_filed_only_after_approval(make_harness, backend):
    backend.respond("POST", "/tickets", 201, {"data": {"id": 7, "status": "open", "title": "VPN down"}})
    harness = make_harness([reply("", [TICKET]), reply("Filed.")], allowed_tools=HELPDESK_TOOLS)
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "my vpn is broken, open a ticket")
    await harness.wait_idle(session)

    request = harness.last("approval.request")["payload"]
    assert "create_ticket VPN down" in request["message"]
    assert backend.calls == []

    harness.runtime.respond_approval(session, "once")
    await harness.wait_idle(session)

    assert backend.calls == [
        {
            "method": "POST",
            "path": "/api/v1/me/tickets",
            "params": {},
            "body": {"title": "VPN down", "description": "Cannot connect since 9am", "priority": "high"},
            "auth": "Bearer user-jwt",
        }
    ]
    assert "Ticket #7 created" in str(harness.model.calls[1][-1].content)


async def test_denied_ticket_is_not_filed(make_harness, backend):
    harness = make_harness([reply("", [TICKET]), reply("Okay.")], allowed_tools=HELPDESK_TOOLS)
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "open a ticket")
    await harness.wait_idle(session)
    harness.runtime.respond_approval(session, "deny")
    await harness.wait_idle(session)

    assert backend.calls == []


async def test_lookups_do_not_need_approval(make_harness, backend):
    backend.respond("GET", "/asset-categories", 200, {"data": [{"id": 5, "name": "Laptop"}]})
    harness = make_harness(
        [reply("", [{"name": "list_asset_categories", "args": {}}]), reply("Laptops are category 5.")],
        allowed_tools=HELPDESK_TOOLS,
    )
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "what can I request?")
    await harness.wait_idle(session)

    assert "approval.request" not in harness.types()
    assert "5: Laptop" in str(harness.model.calls[1][-1].content)


async def test_request_access_maps_fields_for_the_backend(backend):
    backend.respond("POST", "/access-requests", 201, {"data": {"id": 3, "target_system": "SAP", "status": "submitted"}})
    client = helpdesk.MeClient("http://localhost:3000/", helpdesk_token())
    request_access = {t.name: t for t in helpdesk.make_access_request_tools(client)}["request_access"]

    result = await request_access.ainvoke(
        {
            "system_id": 8,
            "request_type": "change",
            "access_level": "Read only",
            "justification": "Monthly reporting",
            "start_date": "2026-11-01",
            "supervisor_name": "Dana",
            "supervisor_title": "Finance Lead",
        }
    )

    assert result == "Access request #3 submitted for SAP with status submitted."
    assert backend.calls[0]["path"] == "/api/v1/me/access-requests"
    assert backend.calls[0]["body"] == {
        "license_id": 8,
        "request_type": "perubahan",
        "access_level_requested": "Read only",
        "business_justification": "Monthly reporting",
        "access_start_date": "2026-11-01",
        "direct_supervisor_name": "Dana",
        "direct_supervisor_title": "Finance Lead",
    }


async def test_request_asset_sends_optional_fields_only_when_given(backend):
    backend.respond("POST", "/asset-requests", 201, {"data": {"id": 11, "status": "pending"}})
    client = helpdesk.MeClient("http://localhost:3000", helpdesk_token())
    request_asset = {t.name: t for t in helpdesk.make_asset_request_tools(client)}["request_asset"]

    result = await request_asset.ainvoke(
        {"category_id": 5, "title": "New laptop", "justification": "Current one is broken"}
    )

    assert result == "Asset request #11 submitted with status pending."
    assert backend.calls[0]["body"] == {
        "category_id": 5,
        "title": "New laptop",
        "justification": "Current one is broken",
        "quantity": 1,
    }


async def test_backend_refusals_are_explained_to_the_model(backend):
    backend.respond(
        "POST",
        "/asset-requests",
        400,
        {"error": "Unknown asset category", "errors": [{"path": "category_id", "message": "Unknown asset category"}]},
    )
    backend.respond("POST", "/access-requests", 409, {"error": "No employee record is linked to your account"})
    client = helpdesk.MeClient("http://localhost:3000", helpdesk_token())
    tools = {t.name: t for t in helpdesk.make_asset_request_tools(client) + helpdesk.make_access_request_tools(client)}

    asset = await tools["request_asset"].ainvoke({"category_id": 99, "title": "x", "justification": "because"})
    access = await tools["request_access"].ainvoke(
        {
            "system_id": 8,
            "request_type": "new",
            "access_level": "Admin",
            "justification": "ops",
            "start_date": "2026-11-01",
            "supervisor_name": "Dana",
            "supervisor_title": "Lead",
        }
    )

    assert "HTTP 400" in asset and "category_id: Unknown asset category" in asset
    assert "HTTP 409" in access and "No employee record" in access


async def test_unreachable_backend_is_reported(monkeypatch):
    real_client = httpx.AsyncClient

    def failing_factory(**kwargs: Any) -> httpx.AsyncClient:
        def handler(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("refused", request=request)

        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(helpdesk.httpx, "AsyncClient", failing_factory)
    client = helpdesk.MeClient("http://localhost:3000", helpdesk_token())
    list_my_tickets = {t.name: t for t in helpdesk.make_ticket_tools(client)}["list_my_tickets"]

    assert "unreachable" in await list_my_tickets.ainvoke({})


def helpdesk_token():
    from novaris_runtime.config import AccessToken

    return AccessToken("user-jwt")
