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

function payload(overrides = {}) {
  return {
    installId: 7,
    deviceBinding: { deviceId: 1, userId: 2, clientId: 3, branchId: null },
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
    releaseMetadata: {},
    installToken: 'install-token',
    ...overrides,
  };
}

test('policy resolves relative endpoints against the backend', () => {
  const policy = AgentRuntimePolicy.fromBootstrap(payload());
  assert.equal(policy.proxyEndpointUrl, 'https://novaris.example.com/api/v1/proxy/chat/completions');
  assert.equal(policy.webSearchEndpointUrl, 'https://novaris.example.com/api/v1/agent-tools/web-search');
  assert.equal('installToken' in policy, false, 'the install token must not be written into the policy file');
});

test('policy maps the [Documents] workspace rule to the Documents folder', () => {
  const policy = AgentRuntimePolicy.fromBootstrap(payload());
  const home = process.env.USERPROFILE || process.env.HOME;
  assert.equal(policy.workspacePath, path.resolve(home, 'Documents', 'AssetAssistant'));
});

test('policy rejects endpoints on another host', () => {
  assert.throws(
    () => AgentRuntimePolicy.fromBootstrap(payload({ proxyEndpointUrl: 'https://evil.example.com/v1/chat/completions' })),
    /must belong to the configured Novaris backend/
  );
});

test('policy rejects plain HTTP outside localhost', () => {
  assert.throws(() => AgentRuntimePolicy.fromBootstrap(payload({ backendBaseUrl: 'http://novaris.example.com' })), /HTTPS/);
  assert.doesNotThrow(() => AgentRuntimePolicy.fromBootstrap(payload({ backendBaseUrl: 'http://localhost:3000' })));
});

test('policy rejects workspaces outside the user profile', () => {
  assert.throws(() => AgentRuntimePolicy.fromBootstrap(payload({ workspacePathRule: '../../etc' })), /inside the current user profile/);
});

test('policy refuses runtimes this app cannot run', () => {
  assert.throws(() => AgentRuntimePolicy.fromBootstrap(payload({ runtime: 'hermes' })), /cannot run the "hermes"/);
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
  const policy = AgentRuntimePolicy.fromBootstrap(payload({
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
    const endpoint = await supervisor.start(policy, 'device-install-token');
    assert.ok(endpoint.port > 0);
    assert.equal(supervisor.isRunning, true);

    const chat = new AgentChatService(() => supervisor.start(policy, 'device-install-token'));
    const events = [];
    const idle = new Promise((resolve) => chat.setEventListener((event) => {
      events.push(event);
      if (event.type === 'session.idle') resolve();
    }));

    await chat.connect();
    await chat.createSession();
    await chat.sendMessage('hi');
    await idle;
    chat.dispose();

    const text = events.filter((e) => e.type === 'message.delta').map((e) => e.payload.text).join('');
    assert.equal(text, 'Hello from Electron.');
    assert.equal(proxy.requests[0].auth, 'Bearer device-install-token');
    assert.equal(proxy.requests[0].url, '/api/v1/proxy/chat/completions');
  } finally {
    await supervisor.stop();
    proxy.server.close();
    fs.rmSync(policy.workspacePath, { recursive: true, force: true });
  }
  assert.equal(supervisor.isRunning, false);
});
