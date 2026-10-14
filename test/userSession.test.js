// Tests for the signed-in user session. Run with `npm run test-electron` (builds first).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { createLogger } = require('../dist/utils/logger');
const { DEFAULT_CONFIG } = require('../dist/types/config');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'novaris-session-test-'));
createLogger({ ...DEFAULT_CONFIG, logLevel: 'error', logFile: path.join(tmp, 'test.log') });

const { UserSessionService, SessionExpiredError } = require('../dist-electron/userSession/userSessionService');

/** A JWT-shaped token; only the payload's exp matters to the agent. */
function jwt(expiresInSeconds, marker = 'a') {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'HS256' })}.${encode({ userId: 2, exp: Math.floor(Date.now() / 1000) + expiresInSeconds, marker })}.sig`;
}

/** In-memory stand-in for the safeStorage-backed store. */
function memoryStore(initial = null) {
  return {
    value: initial,
    save(v) { this.value = v; return true; },
    load() { return this.value; },
    clear() { this.value = null; },
  };
}

const USER = { id: 2, name: 'Rina Putri', email: 'rina@example.com', role: 'staff', client_id: 3, branch_id: null, must_change_password: false };

/** Fake backend; `routes` maps "METHOD /path" to (req, body) => [status, json]. */
async function backend(routes) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const key = `${req.method} ${req.url.replace(/^\/api\/v1/, '')}`;
      calls.push({ key, body, authorization: req.headers.authorization });
      const handler = routes[key];
      const [status, json] = handler ? handler(req, body) : [404, { error: 'Not found' }];
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const apiUrl = `http://127.0.0.1:${server.address().port}/api/v1`;
  return { apiUrl, calls, close: () => new Promise((resolve) => server.close(resolve)) };
}

test('login stores the session and exposes only the profile', async (t) => {
  const token = jwt(24 * 3600);
  const api = await backend({ 'POST /auth/login': () => [200, { data: { token, user: USER } }] });
  t.after(api.close);
  const store = memoryStore();
  const session = new UserSessionService(store, () => api.apiUrl);
  const events = [];
  session.onChange((status) => events.push(status));

  const status = await session.login('rina@example.com', 'secret');

  assert.equal(status.signedIn, true);
  assert.equal(status.user.name, 'Rina Putri');
  assert.equal(status.user.clientId, 3);
  assert.equal(JSON.stringify(status).includes(token), false, 'the JWT must not reach the renderer');
  assert.equal(JSON.parse(store.value).token, token);
  assert.equal(events.length, 1);
});

test('request sends the bearer token and a 401 signs the user out', async (t) => {
  const token = jwt(24 * 3600);
  let authorized = true;
  const api = await backend({
    'POST /auth/login': () => [200, { data: { token, user: USER } }],
    'GET /auth/me': () => (authorized ? [200, { data: USER }] : [401, { error: 'Invalid token' }]),
  });
  t.after(api.close);
  const store = memoryStore();
  const session = new UserSessionService(store, () => api.apiUrl);
  await session.login('rina@example.com', 'secret');

  await session.request({ method: 'GET', url: '/auth/me' });
  assert.equal(api.calls.at(-1).authorization, `Bearer ${token}`);

  authorized = false;
  await assert.rejects(session.request({ method: 'GET', url: '/auth/me' }), SessionExpiredError);
  assert.equal(session.status().signedIn, false);
  assert.equal(store.value, null);
});

test('a token close to expiry is refreshed before use', async (t) => {
  const fresh = jwt(24 * 3600, 'fresh');
  const api = await backend({ 'POST /auth/refresh-token': () => [200, { data: { token: fresh } }] });
  t.after(api.close);
  const store = memoryStore(JSON.stringify({ token: jwt(10 * 60), user: { ...USER, clientId: 3 } }));
  const session = new UserSessionService(store, () => api.apiUrl);
  session.restore();

  assert.equal(await session.getToken(), fresh);
  assert.equal(JSON.parse(store.value).token, fresh);
});

test('restore drops an expired session', () => {
  const store = memoryStore(JSON.stringify({ token: jwt(-60), user: USER }));
  const session = new UserSessionService(store, () => 'http://127.0.0.1:1/api/v1');
  assert.equal(session.restore().signedIn, false);
  assert.equal(store.value, null);
});

test('failed login keeps the user signed out', async (t) => {
  const api = await backend({ 'POST /auth/login': () => [401, { error: 'Invalid email or password' }] });
  t.after(api.close);
  const session = new UserSessionService(memoryStore(), () => api.apiUrl);
  await assert.rejects(session.login('rina@example.com', 'wrong'), (error) => error.response?.status === 401);
  assert.equal(session.status().signedIn, false);
});
