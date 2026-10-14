'use strict';
// Novaris user account: sign-in, profile and password change.
// Shares the helpers ($, api, state, navigate, busy, banner, toast…) declared by the main script.
// Other user-facing pages listen for the `novaris:session` event on document.

state.session = { signedIn: false, user: null, expiresAt: null };

function initials(name, email) {
  const words = String(name || email || '?').trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] || '?') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase();
}

function renderSession() {
  const { signedIn, user, expiresAt } = state.session;
  const avatar = signedIn ? initials(user.name, user.email) : '?';

  $('account-avatar').textContent = avatar;
  $('account-name').textContent = signedIn ? user.name || user.email : 'Sign in';
  $('account-sub').textContent = signedIn ? user.email : 'Use your Novaris account';
  statusBadge($('account-badge'), signedIn ? 'Signed in' : 'Signed out', signedIn ? 'success' : 'neutral');

  $('login-card').hidden = signedIn;
  $('profile-view').hidden = !signedIn;
  if (signedIn) {
    $('profile-avatar').textContent = avatar;
    $('profile-name').textContent = user.name || '—';
    $('profile-email').textContent = user.email || '—';
    $('profile-role').textContent = user.role || '—';
    $('profile-expires').textContent = expiresAt ? formatDate(expiresAt) : '—';
    $('password-copy').textContent = user.mustChangePassword
      ? 'Your administrator requires you to set a new password before continuing.'
      : 'Update the password for your Novaris account.';
    banner('account-message', user.mustChangePassword ? 'You must change your password.' : '', 'warning');
  } else {
    banner('account-message', '');
  }
}

function applySession(status) {
  const wasSignedIn = state.session.signedIn;
  state.session = status || { signedIn: false, user: null, expiresAt: null };
  renderSession();
  if (wasSignedIn && !state.session.signedIn) {
    toast('You have been signed out.');
  }
  document.dispatchEvent(new CustomEvent('novaris:session', { detail: state.session }));
}

async function submitLogin(event) {
  event.preventDefault();
  const form = $('login-form');
  if (!form.reportValidity()) return;
  const btn = $('login-submit');
  busy(btn, true, 'Signing in…');
  banner('account-message', '');
  try {
    const result = await api.userLogin(form.elements.email.value, form.elements.password.value);
    if (!result.success) throw new Error(result.message || 'Sign-in failed');
    form.reset();
    applySession(result.status);
    toast(`Signed in as ${result.status.user.name || result.status.user.email}`);
  } catch (error) {
    form.elements.password.value = '';
    banner('account-message', errorText(error));
  } finally {
    busy(btn, false, 'Sign in');
  }
}

async function submitPasswordChange(event) {
  event.preventDefault();
  const form = $('password-form');
  if (!form.reportValidity()) return;
  const { current, next, confirm } = form.elements;
  if (next.value !== confirm.value) {
    banner('account-message', 'The new passwords do not match.');
    return;
  }
  const btn = $('password-submit');
  busy(btn, true, 'Saving…');
  try {
    const result = await api.userChangePassword(current.value, next.value, confirm.value);
    if (!result.success) throw new Error(result.message || 'Password change failed');
    form.reset();
    applySession(result.status);
    toast('Password changed');
  } catch (error) {
    banner('account-message', errorText(error));
  } finally {
    busy(btn, false, 'Change password');
  }
}

async function logout() {
  if (!await confirmAction('Sign out?', 'Personal features on this device will be unavailable until you sign in again.', 'Sign out')) return;
  applySession(await api.userLogout());
}

function bindAccount() {
  const chip = $('account-chip');
  chip.onclick = () => navigate('account');
  // navigate() only highlights .nav buttons; keep the chip in step with the current page.
  document.addEventListener('click', () => queueMicrotask(() => chip.classList.toggle('active', state.page === 'account')));
  $('login-form').onsubmit = submitLogin;
  $('password-form').onsubmit = submitPasswordChange;
  $('logout-btn').onclick = logout;
  api.onUserSessionChanged((_event, status) => applySession(status));
}

async function initAccount() {
  bindAccount();
  try {
    applySession(await api.userSessionStatus());
  } catch (error) {
    banner('account-message', 'Unable to read the account status: ' + errorText(error));
  }
}

document.addEventListener('DOMContentLoaded', initAccount);
