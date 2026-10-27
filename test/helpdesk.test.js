// Tests for the self-service helpdesk calls. Run with `npm run test-electron` (builds first).
const test = require('node:test');
const assert = require('node:assert/strict');

const { HelpdeskService } = require('../dist-electron/helpdesk/helpdeskService');

/** Records the requests a UserSessionService would send and answers with `{ data }`. */
function fakeSession(data = {}) {
  return {
    calls: [],
    async request(config) {
      this.calls.push(config);
      return { data, message: 'ok' };
    },
  };
}

test('creates a ticket with trimmed fields', async () => {
  const session = fakeSession({ id: 7 });
  const result = await new HelpdeskService(session).createTicket({ title: ' VPN down ', description: 'No access', priority: 'high' });

  assert.deepEqual(result, { id: 7 });
  assert.deepEqual(session.calls, [
    { method: 'POST', url: '/me/tickets', data: { title: 'VPN down', description: 'No access', priority: 'high' } },
  ]);
});

test('rejects a ticket without a title before calling the backend', async () => {
  const session = fakeSession();
  await assert.rejects(new HelpdeskService(session).createTicket({ title: '  ', description: 'x' }), /Title is required/);
  assert.equal(session.calls.length, 0);
});

test('lists tickets and ignores an unknown status filter', async () => {
  const session = fakeSession([]);
  const helpdesk = new HelpdeskService(session);

  await helpdesk.listTickets('open');
  await helpdesk.listTickets('anything');

  assert.deepEqual(session.calls.map((c) => c.params), [{ status: 'open' }, undefined]);
});

test('sends an asset request with numeric ids and optional fields only when set', async () => {
  const session = fakeSession({ id: 11 });
  await new HelpdeskService(session).requestAsset({
    category_id: '5',
    title: 'Monitor',
    justification: 'Second screen for design work',
    quantity: '2',
    needed_by: '',
  });

  assert.deepEqual(session.calls[0].data, {
    category_id: 5,
    title: 'Monitor',
    justification: 'Second screen for design work',
    quantity: 2,
  });
});

test('sends an access request and validates its dates and type', async () => {
  const session = fakeSession({ id: 3 });
  const helpdesk = new HelpdeskService(session);
  const form = {
    license_id: '8',
    request_type: 'baru',
    access_level_requested: 'Read only',
    business_justification: 'Monthly reporting',
    access_start_date: '2026-11-01',
    access_end_date: '',
    direct_supervisor_name: 'Dana',
    direct_supervisor_title: 'Finance Lead',
    notes: '',
  };

  await helpdesk.requestAccess(form);
  assert.equal(session.calls[0].url, '/me/access-requests');
  assert.deepEqual(session.calls[0].data, {
    license_id: 8,
    request_type: 'baru',
    access_level_requested: 'Read only',
    business_justification: 'Monthly reporting',
    access_start_date: '2026-11-01',
    direct_supervisor_name: 'Dana',
    direct_supervisor_title: 'Finance Lead',
  });

  await assert.rejects(helpdesk.requestAccess({ ...form, request_type: 'admin' }), /Request type is invalid/);
  await assert.rejects(helpdesk.requestAccess({ ...form, access_start_date: '01/11/2026' }), /Start date must be a date/);
  await assert.rejects(helpdesk.requestAccess(null), /Invalid request/);
});
