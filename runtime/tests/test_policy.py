from __future__ import annotations

from fakes import reply
from novaris_runtime.policy import build_tool_policy


def test_full_policy_exposes_read_and_write_tools():
    policy = build_tool_policy(["file_reader", "file_writer", "web_search"])

    assert set(policy.filesystem_tools) == {"ls", "read_file", "glob", "grep", "write_file", "edit_file", "delete"}
    assert policy.permissions == []
    assert policy.web_search
    assert policy.can_write


def test_read_only_policy_denies_writes():
    policy = build_tool_policy(["file_reader"])

    assert "write_file" not in policy.filesystem_tools
    assert not policy.can_write
    assert [(p.operations, p.mode) for p in policy.permissions] == [(["write"], "deny")]
    assert not policy.web_search


def test_empty_policy_denies_all_file_access():
    policy = build_tool_policy([])

    assert policy.filesystem_tools == ("read_file",)
    assert {tuple(p.operations) for p in policy.permissions} == {("read",), ("write",)}


def test_unknown_tools_are_ignored():
    policy = build_tool_policy(["file_reader", "terminal"])

    assert "execute" not in policy.filesystem_tools


async def test_model_never_sees_execute_or_hidden_tools(make_harness):
    harness = make_harness([reply("hello")], allowed_tools=("file_reader",))
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "hi")
    await harness.wait_idle(session)

    seen = set(harness.model.bound_tool_names[0])
    assert {"ls", "read_file", "glob", "grep", "ask_user"} <= seen
    assert not seen & {"execute", "write_file", "edit_file", "delete", "web_search"}


async def test_write_is_refused_even_if_the_model_calls_a_hidden_tool(make_harness):
    harness = make_harness(
        [reply("", [{"name": "write_file", "args": {"file_path": "/x.txt", "content": "x"}}]), reply("ok")],
        allowed_tools=("file_reader",),
    )
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "write x")
    await harness.wait_idle(session)

    assert not (harness.config.workspace_path / "x.txt").exists()
    assert "approval.request" not in harness.types()
