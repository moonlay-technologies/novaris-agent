from __future__ import annotations

import pytest

from fakes import reply
from novaris_runtime.session import SessionError, user_facing_error

WRITE_A = {"name": "write_file", "args": {"file_path": "/a.txt", "content": "hello"}}


async def test_streams_a_plain_answer(make_harness):
    harness = make_harness([reply("Hi there, how can I help?")])
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "hello")
    await harness.wait_idle(session)

    assert harness.text() == "Hi there, how can I help?"
    assert harness.types()[0] == "message.start"
    assert harness.types()[-2:] == ["message.complete", "session.idle"]
    assert all(e["session_id"] == session for e in harness.events)


async def test_reads_files_from_the_workspace(make_harness):
    harness = make_harness([reply("", [{"name": "read_file", "args": {"file_path": "/notes.txt"}}]), reply("Read it.")])
    harness.config.workspace_path.mkdir(parents=True, exist_ok=True)
    (harness.config.workspace_path / "notes.txt").write_text("secret plan", encoding="utf-8")
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "read notes")
    await harness.wait_idle(session)

    tool_message = harness.model.calls[1][-1]
    assert "secret plan" in str(tool_message.content)
    assert harness.last("tool.result")["payload"] == {"name": "read_file", "status": "success"}


async def test_cannot_escape_the_workspace(make_harness, tmp_path):
    (tmp_path / "outside.txt").write_text("do not read", encoding="utf-8")
    harness = make_harness(
        [reply("", [{"name": "read_file", "args": {"file_path": "/../outside.txt"}}]), reply("done")]
    )
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "read outside")
    await harness.wait_idle(session)

    assert "do not read" not in str(harness.model.calls[1][-1].content)


async def test_write_waits_for_approval_then_applies(make_harness):
    harness = make_harness([reply("Writing.", [WRITE_A]), reply("Done.")])
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "write a")
    await harness.wait_idle(session)

    request = harness.last("approval.request")["payload"]
    assert "write_file /a.txt" in request["message"]
    assert request["choices"] == ["once", "session", "always", "deny"]
    assert not (harness.config.workspace_path / "a.txt").exists()

    harness.runtime.respond_approval(session, "once")
    await harness.wait_idle(session)

    assert (harness.config.workspace_path / "a.txt").read_text(encoding="utf-8") == "hello"
    assert harness.types()[-1] == "session.idle"


async def test_denied_write_is_not_applied(make_harness):
    harness = make_harness([reply("", [WRITE_A]), reply("Okay, I won't.")])
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "write a")
    await harness.wait_idle(session)
    harness.runtime.respond_approval(session, "deny")
    await harness.wait_idle(session)

    assert not (harness.config.workspace_path / "a.txt").exists()
    assert harness.text().endswith("Okay, I won't.")


async def test_session_approval_skips_later_prompts_in_that_session_only(make_harness):
    write_b = {"name": "write_file", "args": {"file_path": "/b.txt", "content": "b"}}
    write_c = {"name": "write_file", "args": {"file_path": "/c.txt", "content": "c"}}
    harness = make_harness([reply("", [WRITE_A]), reply("one"), reply("", [write_b]), reply("two"), reply("", [write_c])])
    first = harness.runtime.create_session()

    harness.runtime.submit(first, "write a")
    await harness.wait_idle(first)
    harness.runtime.respond_approval(first, "session")
    await harness.wait_idle(first)
    approvals_so_far = harness.types().count("approval.request")

    harness.runtime.submit(first, "write b")
    await harness.wait_idle(first)
    assert (harness.config.workspace_path / "b.txt").exists()
    assert harness.types().count("approval.request") == approvals_so_far

    second = harness.runtime.create_session()
    harness.runtime.submit(second, "write c")
    await harness.wait_idle(second)
    assert harness.types().count("approval.request") == approvals_so_far + 1


async def test_always_approval_is_saved(make_harness):
    harness = make_harness([reply("", [WRITE_A]), reply("done")])
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "write a")
    await harness.wait_idle(session)
    harness.runtime.respond_approval(session, "always")
    await harness.wait_idle(session)

    assert '"write_file"' in (harness.config.data_dir / "approvals.json").read_text(encoding="utf-8")


async def test_ask_user_turns_into_a_clarify_request(make_harness):
    harness = make_harness(
        [reply("", [{"name": "ask_user", "args": {"question": "Which folder?"}}]), reply("Using reports.")]
    )
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "tidy up")
    await harness.wait_idle(session)

    request = harness.last("clarify.request")["payload"]
    assert request["question"] == "Which folder?"

    harness.runtime.respond_clarify(request["clarify_id"], "reports")
    await harness.wait_idle(session)

    answer = harness.model.calls[1][-1]
    assert answer.content == "reports"
    assert harness.text().endswith("Using reports.")


async def test_rejects_new_prompts_while_a_request_is_pending(make_harness):
    harness = make_harness([reply("", [WRITE_A])])
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "write a")
    await harness.wait_idle(session)

    with pytest.raises(SessionError, match="pending request"):
        harness.runtime.submit(session, "something else")


async def test_validates_input(make_harness):
    harness = make_harness([])
    session = harness.runtime.create_session()

    with pytest.raises(SessionError):
        harness.runtime.submit(session, "   ")
    with pytest.raises(SessionError):
        harness.runtime.submit(session, "x" * 20_001)
    with pytest.raises(SessionError, match="Unknown session"):
        harness.runtime.submit("nope", "hi")
    with pytest.raises(ValueError):
        harness.runtime.respond_approval(session, "maybe")


async def test_history_is_kept_per_session(make_harness):
    harness = make_harness([reply("first"), reply("second")])
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "one")
    await harness.wait_idle(session)
    harness.runtime.submit(session, "two")
    await harness.wait_idle(session)

    contents = [m.content for m in harness.model.calls[1] if m.type in ("human", "ai")]
    assert contents[-3:] == ["one", "first", "two"]


async def test_model_errors_become_error_events(make_harness):
    harness = make_harness([])

    async def boom(*args, **kwargs):
        raise RuntimeError("upstream exploded")
        yield  # pragma: no cover

    harness.runtime._agent.astream = boom  # type: ignore[method-assign]
    session = harness.runtime.create_session()

    harness.runtime.submit(session, "hi")
    await harness.wait_idle(session)

    assert harness.last("error")["payload"]["message"] == "Something went wrong while answering. Try again."
    assert harness.types()[-1] == "session.idle"


@pytest.mark.parametrize(
    ("status", "fragment"),
    [(401, "Sign in again"), (403, "not allowed"), (429, "usage limit"), (502, "unavailable")],
)
def test_user_facing_errors(status, fragment):
    error = Exception("x")
    error.status_code = status  # type: ignore[attr-defined]
    assert fragment in user_facing_error(error)
