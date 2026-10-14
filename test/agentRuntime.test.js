// Tests for the Electron-side agent runtime integration. Run with `npm run test-electron`
// (builds first). Uses Node's built-in test runner against the compiled output.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { createLogger } = require('../dist/utils/logger');
const { DEFAULT_CONFIG } = require('../dist/types/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-agent-test-'));
createLogger({ ...DEFAULT_CONFIG, logLevel: 'error', logFile: path.join(tmp, 'test.log') });

const { AgentRuntimePolicy } = require('../dist-electron/agentRuntime/runtimePolicy');
const { AgentRuntimeSupervisor } = require('../dist-electron/agentRuntime/supervisor');
const { AgentChatService } = require('../dist-electron/agentRuntime/chatService');
const { AgentRuntimeManager } = require('../dist-electron/agentRuntime/agentRuntimeManager');

function payload(overrides = {}) {
  return {
    backendBaseUrl: 'https://novaris.example.com',
    proxyEndpointUrl: '/api/v1/proxy/chat/completions',
    policyVersion: 'v2',
    allowedTools: ['file_reader', 'file_writer', 'web_search'],
    workspacePathRule: '[Documents]/AssetAssistant',
    runtime: 'deepagents',
    model: 'gpt-4o-mini',
    maxInputTokens: 128000,
    systemPrompt: 'Be helpful.',
    webSearchEndpointUrl: '/api/v1/agent-tools/web-search',
    ...overrides,
  };
}

test('policy resolves relative endpoints against the backend', () => {
  const policy = AgentRuntimePolicy.fromPayload(payload());
  assert.equal(policy.proxyEndpointUrl, 'https://novaris.example.com/api/v1/proxy/chat/completions');
  assert.equal(policy.webSearchEndpointUrl, 'https://novaris.example.com/api/v1/agent-tools/web-search');
  assert.equal('accessToken' in policy, false, 'the user JWT must not be written into the policy file');
});

test('policy maps the [Documents] workspace rule to the Documents folder', () => {
  const policy = AgentRuntimePolicy.fromPayload(payload());
  const home = process.env.USERPROFILE || process.env.HOME;
  assert.equal(policy.workspacePath, path.resolve(home, 'Documents', 'AssetAssistant'));
});

test('policy rejects endpoints on another host', () => {
  assert.throws(
    () => AgentRuntimePolicy.fromPayload(payload({ proxyEndpointUrl: 'https://evil.example.com/v1/chat/completions' })),
    /must belong to the configured Novaris backend/
  );
});

test('policy rejects plain HTTP outside localhost', () => {
  assert.throws(() => AgentRuntimePolicy.fromPayload(payload({ backendBaseUrl: 'http://novaris.example.com' })), /HTTPS/);
  assert.doesNotThrow(() => AgentRuntimePolicy.fromPayload(payload({ backendBaseUrl: 'http://localhost:3000' })));
});

test('policy rejects workspaces outside the user profile', () => {
  assert.throws(() => AgentRuntimePolicy.fromPayload(payload({ workspacePathRule: '../../etc' })), /inside the current user profile/);
});

test('policy refuses runtimes this app cannot run', () => {
  assert.throws(() => AgentRuntimePolicy.fromPayload(payload({ runtime: 'hermes' })), /cannot run the "hermes"/);
});

test('manager refuses to start the assistant when nobody is signed in', async () => {
  const runtimeDir = path.join(tmp, 'manager-signed-out');
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, 'install-token.bin'), 'legacy');
  let requested = false;
  const manager = new AgentRuntimeManager({
    runtimeDir,
    supervisor: { isRunning: false, start: () => assert.fail('must not start'), stop: async () => {}, updateAccessToken() {} },
    userSession: { isSignedIn: () => false, getToken: async () => 'jwt', request: async () => { requested = true; } },
  });
  assert.equal(fs.existsSync(path.join(runtimeDir, 'install-token.bin')), false, 'legacy install token is removed');
  assert.equal(manager.status().available, false);
  await assert.rejects(manager.endpoint(), /Sign in/);
  assert.equal(requested, false);
});

test('manager loads the policy from /me/assistant and starts with the user JWT', async () => {
  const started = [];
  const manager = new AgentRuntimeManager({
    runtimeDir: path.join(tmp, 'manager-signed-in'),
    supervisor: {
      isRunning: false,
      start: async (policy, token) => { started.push({ policy, token }); return { port: 1, token: 'ws' }; },
      stop: async () => {},
      updateAccessToken() {},
    },
    userSession: {
      isSignedIn: () => true,
      getToken: async () => 'user-jwt',
      request: async ({ url }) => {
        assert.equal(url, '/me/assistant');
        return { data: {
          backend_base_url: 'https://novaris.example.com',
          proxy_endpoint_url: '/api/v1/proxy/chat/completions',
          web_search_endpoint_url: null,
          policy_version: 'v2',
          allowed_tools: ['file_reader'],
          workspace_path_rule: '[Documents]/AssetAssistant',
          runtime: 'deepagents',
          model: 'gpt-5-mini',
          max_input_tokens: 64000,
          system_prompt: '',
        } };
      },
    },
  });
  await manager.endpoint();
  assert.equal(started[0].token, 'user-jwt');
  assert.equal(started[0].policy.model, 'gpt-5-mini');
  assert.equal(started[0].policy.proxyEndpointUrl, 'https://novaris.example.com/api/v1/proxy/chat/completions');
  assert.equal(manager.status().model, 'gpt-5-mini');
});

function hasUv() {
  if (process.env.NOVARIS_TEST_RESOURCES) return true;
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore' });
    return fs.existsSync(path.join(__dirname, '..', 'runtime', '.venv'));
  } catch {
    return false;
  }
}

/** Minimal OpenAI-compatible proxy that streams one fixed answer. */
function startMockProxy() {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body || '{}') });
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const base = { id: 'c1', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini' };
      const chunks = [
        { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: 'Hello' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: { content: ' from Electron.' }, finish_reason: null }] },
        { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { ...base, choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
      ];
      for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, requests, port: server.address().port })));
}

test('supervisor starts the runtime and the chat client streams an answer', { skip: !hasUv() && 'uv or runtime/.venv missing', timeout: 120000 }, async () => {
  const proxy = await startMockProxy();
  const baseUrl = `http://localhost:${proxy.port}`;
  const policy = AgentRuntimePolicy.fromPayload(payload({
    backendBaseUrl: baseUrl,
    allowedTools: ['file_reader'],
    workspacePathRule: path.join(os.homedir(), `.novaris-test-workspace-${process.pid}`),
  }));
  const supervisor = new AgentRuntimeSupervisor({
    // Point NOVARIS_TEST_RESOURCES at a packaged app's resources/ to test the bundled runtime instead of uv.
    resourcesPath: process.env.NOVARIS_TEST_RESOURCES || path.join(tmp, 'no-resources'),
    runtimeDir: path.join(tmp, 'runtime'),
    isPackaged: false,
    devRuntimeDir: path.join(__dirname, '..', 'runtime'),
  });

  try {
    const endpoint = await supervisor.start(policy, 'user-jwt-1');
    assert.ok(endpoint.port > 0);
    assert.equal(supervisor.isRunning, true);

    const chat = new AgentChatService(() => supervisor.start(policy, 'user-jwt-1'));
    const events = [];
    let onIdle = () => {};
    chat.setEventListener((event) => {
      events.push(event);
      if (event.type === 'session.idle') onIdle();
    });
    const ask = async (text) => {
      const idle = new Promise((resolve) => { onIdle = resolve; });
      await chat.sendMessage(text);
      await idle;
    };

    await chat.connect();
    await chat.createSession();
    await ask('hi');

    const text = events.filter((e) => e.type === 'message.delta').map((e) => e.payload.text).join('');
    assert.equal(text, 'Hello from Electron.');
    assert.equal(proxy.requests[0].auth, 'Bearer user-jwt-1');
    assert.equal(proxy.requests[0].url, '/api/v1/proxy/chat/completions');

    // A refreshed JWT reaches the running runtime over stdin without a restart.
    supervisor.updateAccessToken('user-jwt-2');
    await new Promise((resolve) => setTimeout(resolve, 500));
    await ask('again');
    chat.dispose();
    assert.equal(proxy.requests.at(-1).auth, 'Bearer user-jwt-2');
  } finally {
    await supervisor.stop();
    proxy.server.close();
    fs.rmSync(policy.workspacePath, { recursive: true, force: true });
  }
  assert.equal(supervisor.isRunning, false);
});
