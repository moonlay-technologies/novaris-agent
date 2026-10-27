'use strict';
// Requests page: the user's helpdesk tickets plus forms for new tickets, access requests and asset requests.
// Shares the helpers ($, $$, api, state, navigate, busy, banner, toast…) declared by the main script.
// Calls go through the main process, which sends them to the backend as the signed-in user.

state.requests = { tab: 'tickets', tickets: [], optionsLoaded: false };

const TICKET_STATUS = {
  open: ['Open', 'info'],
  in_progress: ['In progress', 'warning'],
  waiting: ['Waiting', 'neutral'],
  resolved: ['Resolved', 'success'],
  closed: ['Closed', 'neutral'],
};

/** Unwraps a `{ success, data, message }` IPC result, throwing the backend's message on failure. */
async function helpdeskCall(promise) {
  const result = await promise;
  if (!result?.success) throw new Error(result?.message || 'Request failed');
  return result.data;
}

function renderRequestsAccess() {
  const signedIn = Boolean(state.session?.signedIn);
  $('requests-signin').hidden = signedIn;
  $('requests-body').hidden = !signedIn;
  $('requests-refresh').hidden = !signedIn;
  if (!signedIn) {
    state.requests.optionsLoaded = false;
    banner('requests-message', '');
  }
}

function selectRequestTab(tab) {
  state.requests.tab = tab;
  $$('[data-request-tab]').forEach((b) => {
    const active = b.dataset.requestTab === tab;
    b.classList.toggle('active', active);
    b.setAttribute('aria-selected', String(active));
  });
  $$('.request-panel').forEach((p) => p.classList.toggle('active', p.dataset.requestPanel === tab));
  banner('requests-message', '');
  if (tab === 'tickets') refreshTickets();
  if (tab === 'access' || tab === 'asset') loadRequestOptions();
}

async function refreshTickets() {
  if (!state.session?.signedIn) return;
  const body = $('ticket-body');
  body.innerHTML = '<tr><td colspan="5">Loading…</td></tr>';
  try {
    state.requests.tickets = (await helpdeskCall(api.helpdeskListTickets($('ticket-status-filter').value || undefined))) || [];
    renderTickets();
  } catch (error) {
    body.innerHTML = '<tr><td colspan="5">Tickets are unavailable.</td></tr>';
    banner('requests-message', 'Unable to load your tickets: ' + errorText(error));
  }
}

function renderTickets() {
  const tickets = state.requests.tickets;
  if (!tickets.length) {
    $('ticket-body').innerHTML = '<tr><td colspan="5">You have no tickets yet.</td></tr>';
    return;
  }
  $('ticket-body').innerHTML = tickets
    .map((t) => {
      const [label, kind] = TICKET_STATUS[t.status] || [t.status || 'Unknown', 'neutral'];
      return `<tr><td>#${escapeHtml(t.id)}</td><td class="process-name"><strong>${escapeHtml(t.title)}</strong><small>${escapeHtml(
        String(t.description || '').slice(0, 140)
      )}</small></td><td><span class="badge ${kind}">${escapeHtml(label)}</span></td><td>${escapeHtml(
        t.priority || '—'
      )}</td><td>${escapeHtml(formatDate(t.created_at))}</td></tr>`;
    })
    .join('');
}

function fillSelect(select, items, label, emptyText) {
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = items.length ? 'Select…' : emptyText;
  select.append(placeholder);
  for (const item of items) {
    const option = document.createElement('option');
    option.value = String(item.id);
    option.textContent = label(item);
    select.append(option);
  }
  select.disabled = !items.length;
}

async function loadRequestOptions(force = false) {
  if (!state.session?.signedIn || (state.requests.optionsLoaded && !force)) return;
  const systems = $('access-form').elements.license_id;
  const categories = $('asset-form').elements.category_id;
  try {
    const [systemList, categoryList] = await Promise.all([
      helpdeskCall(api.helpdeskAccessSystems()),
      helpdeskCall(api.helpdeskAssetCategories()),
    ]);
    fillSelect(systems, systemList || [], (s) => (s.product && s.product !== s.name ? `${s.name} (${s.product})` : s.name), 'No systems available');
    fillSelect(categories, categoryList || [], (c) => c.name, 'No categories available');
    state.requests.optionsLoaded = true;
  } catch (error) {
    banner('requests-message', 'Unable to load request options: ' + errorText(error));
  }
}

function formValues(form) {
  const values = {};
  for (const [key, value] of new FormData(form).entries()) values[key] = typeof value === 'string' ? value.trim() : value;
  return values;
}

/** Shared submit flow: validate, send, report, reset. */
function bindRequestForm(formId, buttonId, label, submit, describe) {
  const form = $(formId);
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    const button = $(buttonId);
    busy(button, true, 'Submitting…');
    banner('requests-message', '');
    try {
      const created = await submit(formValues(form));
      form.reset();
      banner('requests-message', describe(created), 'success');
      toast(describe(created));
    } catch (error) {
      banner('requests-message', errorText(error));
    } finally {
      busy(button, false, label);
    }
  };
}

function bindRequests() {
  $$('[data-request-tab]').forEach((b) => (b.onclick = () => selectRequestTab(b.dataset.requestTab)));
  $$('[data-request-goto]').forEach((b) => (b.onclick = () => selectRequestTab(b.dataset.requestGoto)));
  $('ticket-status-filter').onchange = refreshTickets;
  $('requests-refresh').onclick = () => {
    if (state.requests.tab === 'tickets') refreshTickets();
    else loadRequestOptions(true);
  };

  bindRequestForm(
    'ticket-form',
    'ticket-submit',
    'Submit ticket',
    (values) => helpdeskCall(api.helpdeskCreateTicket(values)),
    (ticket) => `Ticket #${ticket?.id ?? ''} created. IT will follow up.`
  );
  bindRequestForm(
    'access-form',
    'access-submit',
    'Submit access request',
    (values) => helpdeskCall(api.helpdeskRequestAccess(values)),
    (request) => `Access request #${request?.id ?? ''} submitted for approval.`
  );
  bindRequestForm(
    'asset-form',
    'asset-submit',
    'Submit asset request',
    (values) => helpdeskCall(api.helpdeskRequestAsset({ ...values, quantity: Number(values.quantity) || 1 })),
    (request) => `Asset request #${request?.id ?? ''} submitted for approval.`
  );

  // Start dates default to today; reset() restores this default.
  const today = new Date();
  const iso = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
  $('access-form').elements.access_start_date.defaultValue = iso;

  document.addEventListener('novaris:session', () => {
    renderRequestsAccess();
    if (state.page === 'requests' && state.session.signedIn) selectRequestTab(state.requests.tab);
  });
  document.addEventListener('novaris:navigate', (event) => {
    if (event.detail?.page !== 'requests') return;
    renderRequestsAccess();
    if (state.session?.signedIn) selectRequestTab(state.requests.tab);
  });
}

document.addEventListener('DOMContentLoaded', () => {
  bindRequests();
  renderRequestsAccess();
});
