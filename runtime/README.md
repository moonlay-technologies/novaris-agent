# Novaris agent runtime

The local AI assistant, built on [LangChain Deep Agents](https://docs.langchain.com/oss/python/deepagents/overview).
Electron starts it as a child process (`src-electron/agentRuntime/supervisor.ts`) and talks to it over a
loopback WebSocket. It replaced the Hermes Agent runtime.

```
Electron UI ─IPC─> AgentChatService ─ws://127.0.0.1:<port>/api/ws?token=…─> novaris-runtime
                                                                           └─ create_deep_agent
                                                                              ├─ model: backend /api/v1/proxy (install token)
                                                                              ├─ files: workspace folder (virtual_mode, writes need approval)
                                                                              ├─ web_search: backend /api/v1/agent-tools/web-search
                                                                              ├─ memory: <data>/memories/AGENTS.md
                                                                              └─ history: <data>/checkpoints.sqlite
```

No provider API keys ever reach the device: model calls and web search go through the backend, which
authenticates the install token and bills usage to the install's user.

## Development

Requires [uv](https://docs.astral.sh/uv/). Python 3.12 is pinned in `.python-version`.

```bash
uv sync
uv run pytest -q
```

When Electron runs unpackaged (`npm run dev-electron`) and no bundle exists under `resources/agent-runtime`,
the supervisor runs `uv run --frozen python -m novaris_runtime` in this folder instead.

## Building the bundle

```bash
uv run python build.py
```

Produces `dist/novaris-runtime/` (one-folder PyInstaller build, about 70 MB) and smoke-tests it.
electron-builder copies it to `resources/agent-runtime/` (see `extraResources` in `package.json`).
PyInstaller cannot cross-compile, so each OS is built on its own CI runner (`.github/workflows/build.yml`).
To run the end-to-end test against a bundle: `NOVARIS_RUNTIME_EXE=dist/novaris-runtime/novaris-runtime.exe uv run pytest tests/test_process.py`.

## Process contract

Environment set by the supervisor:

| Variable | Meaning |
|---|---|
| `NOVARIS_POLICY_FILE` | JSON policy written by Electron (`LockedAgentPolicy`). |
| `NOVARIS_INSTALL_TOKEN` | Install token; authenticates to the backend. Never written to the policy file. |
| `NOVARIS_RUNTIME_TOKEN` | Random per-launch secret the WebSocket client must present. |
| `NOVARIS_DATA_DIR` | Chat history, memory and approval grants. |
| `NOVARIS_RUNTIME_PORT` | `0` picks a free port. |

On startup the process prints `NOVARIS_RUNTIME_READY {"port": N}`; everything else on stdout is JSON log lines.
It exits when stdin closes, so it never outlives Electron. Exit code `2` means the configuration was rejected
(the supervisor does not restart it); other exits are restarted with backoff.

## WebSocket protocol

JSON-RPC 2.0, kept compatible with the Hermes gateway protocol the app used before.

Requests: `session.create {session_id?}` → `{session_id}`, `prompt.submit {session_id, text}`,
`approval.respond {session_id, choice: once|session|always|deny}`, `clarify.respond {clarify_id, response}`,
`runtime.status`.

Events (`{"method": "event", "params": {"type", "session_id", "payload"}}`): `gateway.ready`, `message.start`,
`message.delta {text}`, `message.complete`, `reasoning.delta {text}`, `tool.result {name, status}`,
`approval.request {message, actions, choices}`, `clarify.request {clarify_id, question}`, `error {message}`,
`session.idle`.

## Tool policy

| Backend policy tool | Deep Agents tools |
|---|---|
| `file_reader` | `ls`, `read_file`, `glob`, `grep` |
| `file_writer` | `write_file`, `edit_file`, `delete`; always interrupt for approval |
| `web_search` | `web_search` (backend endpoint) |
| always | `ask_user` (becomes a `clarify.request`), `task` (general-purpose subagent with the same restrictions) |

There is no shell (`execute`), no skills directory, and no messaging gateways. Tools outside the policy are
hidden from the model and also denied by `FilesystemPermission` rules.

## Upgrading Deep Agents

`deepagents` is pinned exactly in `pyproject.toml` because its API changes between minor versions.
`agent.py` relies on replacing `FilesystemMiddleware` by name and on its private `_permissions` argument;
`tests/test_policy.py` and `tests/test_subagents.py` fail if an upgrade breaks that.
