from __future__ import annotations

from fakes import reply


async def test_writes_inside_a_subagent_still_need_approval(make_harness):
    # One scripted model serves both the main agent and the general-purpose subagent, in call order.
    harness = make_harness(
        [
            reply("", [{"name": "task", "args": {"description": "Write a.txt", "subagent_type": "general-purpose"}}]),
            reply("", [{"name": "write_file", "args": {"file_path": "/a.txt", "content": "from subagent"}}]),
            reply("Subagent wrote the file."),
            reply("All done."),
        ]
    )
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "delegate it")
    await harness.wait_idle(session)

    assert "write_file /a.txt" in harness.last("approval.request")["payload"]["message"]
    assert not (harness.config.workspace_path / "a.txt").exists()

    harness.runtime.respond_approval(session, "once")
    await harness.wait_idle(session)

    assert (harness.config.workspace_path / "a.txt").read_text(encoding="utf-8") == "from subagent"
    assert harness.text().endswith("All done.")
    # Subagent text stays internal; only the main agent's answer streams to the user.
    assert "Subagent wrote the file." not in harness.text()


async def test_subagent_gets_the_same_restricted_tools(make_harness):
    harness = make_harness(
        [
            reply("", [{"name": "task", "args": {"description": "look around", "subagent_type": "general-purpose"}}]),
            reply("nothing to do"),
            reply("ok"),
        ],
        allowed_tools=("file_reader",),
    )
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "delegate")
    await harness.wait_idle(session)

    subagent_tools = set(harness.model.bound_tool_names[1])
    assert "read_file" in subagent_tools
    assert not subagent_tools & {"write_file", "edit_file", "delete", "execute"}
