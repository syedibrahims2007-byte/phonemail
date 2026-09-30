/* PhoneMail web UI - vanilla JS, no build step */
'use strict';

/* ============================================================
   small helpers
   ============================================================ */
const $  = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => Array.prototype.slice.call((root || document).querySelectorAll(sel));

function esc(value) {
  return String(value === null || value === undefined ? '' : value).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function dt(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (isNaN(d)) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function ago(value) {
  if (!value) return 'never';
  const diff = Date.now() - new Date(value).getTime();
  if (isNaN(diff)) return 'never';
  const mins = Math.round(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return hrs + 'h ago';
  const days = Math.round(hrs / 24);
  return days + (days === 1 ? ' day ago' : ' days ago');
}

function busy(btn, on, idleLabel) {
  if (!btn) return;
  if (on) {
    if (!btn.dataset.label) btn.dataset.label = btn.textContent;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.disabled = false;
    btn.textContent = idleLabel || btn.dataset.label || btn.textContent;
  }
}

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : JSON.parse(raw);
    } catch (e) { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* quota / private mode */ }
  },
  del(key) {
    try { localStorage.removeItem(key); } catch (e) { /* ignore */ }
  },
};

/* ============================================================
   state
   ============================================================ */
const state = {
  token: store.get('pm.token', null),
  refreshToken: store.get('pm.refresh', null),
  expiresAt: store.get('pm.expiresAt', 0),
  account: store.get('pm.account', null),
  recoveryCodesRemaining: store.get('pm.rcLeft', null),
  recoveryCodes: store.get('pm.rc', null),

  // auth flow
  step: 1,
  phone: '',
  channel: 'SMS',
  challengeId: null,
  otp: '',
  devOtp: null,
  otpExpiresAt: 0,
  otpTimer: null,
  needsStepUp: false,

  // inbox
  inbox: { messages: [], total: 0, limit: 20, offset: 0, status: '', category: '', q: '', selected: [], loading: false },
  categories: [],

  // add-phone flow
  addPhone: { open: false, bindingId: null, challengeId: null, devOtp: null },

  // text messages
  sms: {
    threads: [],
    activeId: null,
    active: null,
    messages: [],
    hasMore: false,
    filter: '',
    maxBody: 1600,
    devMode: false,
  },

  tab: store.get('pm.tab', 'inbox'),
  pollTimer: null,
  sessionTimer: null,
  refreshTimer: null,
  refreshInFlight: null,
  events: null,
};

/* ============================================================
   theme
   ============================================================ */
function initTheme() {
  const saved = store.get('pm.theme', null);
  const theme = saved || (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
  applyTheme(theme);
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  store.set('pm.theme', theme);
  const btn = $('#btn-theme');
  if (btn) btn.innerHTML = theme === 'dark' ? '&#9789;' : '&#9788;';
}
function toggleTheme() {
  applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
}

/* ============================================================
   toast + confirm modal
   ============================================================ */
let toastTimer;
function toast(message, isError) {
  const el = $('#toast');
  el.textContent = message;
  el.className = 'show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 4000);
}

let modalResolve = null;
function confirmDialog(title, body, okLabel) {
  $('#modal-title').textContent = title;
  $('#modal-body').textContent = body;
  $('#modal-ok').textContent = okLabel || 'Confirm';
  $('#modal').hidden = false;
  return new Promise((resolve) => { modalResolve = resolve; });
}
function closeModal(result) {
  $('#modal').hidden = true;
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(result); }
}
$('#modal-cancel').onclick = () => closeModal(false);
$('#modal-ok').onclick = () => closeModal(true);
$('#modal').addEventListener('click', (e) => { if (e.target === $('#modal')) closeModal(false); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('#modal').hidden) closeModal(false);
});

/* ============================================================
   api layer - with transparent access-token refresh
   ============================================================ */

function setTokens(tokens) {
  state.token = tokens.accessToken;
  state.refreshToken = tokens.refreshToken || state.refreshToken;
  state.expiresAt = Date.now() + (tokens.expiresIn || 900) * 1000;
  store.set('pm.token', state.token);
  store.set('pm.refresh', state.refreshToken);
  store.set('pm.expiresAt', state.expiresAt);
  scheduleRefresh();
}

// Single-flight: many parallel 401s must not each burn a refresh token.
function refreshSession() {
  if (state.refreshInFlight) return state.refreshInFlight;
  if (!state.refreshToken) return Promise.resolve(false);

  state.refreshInFlight = (async () => {
    try {
      const res = await fetch('/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: state.refreshToken }),
      });
      if (!res.ok) {
        // Refresh token is dead too - the session is genuinely over.
        if (res.status === 401) signOut(false, 'Session expired. Sign in again.');
        return false;
      }
      setTokens(await res.json());
      return true;
    } catch (e) {
      return false;
    } finally {
      state.refreshInFlight = null;
    }
  })();

  return state.refreshInFlight;
}

// Renew a minute early so the user never sees a 401 flicker.
function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  if (!state.token) return;
  const lead = state.expiresAt - Date.now() - 60000;
  state.refreshTimer = setTimeout(async () => {
    const ok = await refreshSession();
    if (ok) startSessionClock();
  }, Math.max(lead, 5000));
}

async function api(path, options, allowRetry) {
  const opts = options || {};
  const headers = {};
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';

  const token = opts.token !== undefined ? opts.token : state.token;
  if (token) headers['Authorization'] = 'Bearer ' + token;

  let res;
  try {
    res = await fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (e) {
    throw apiError('Cannot reach the server', 0, null);
  }

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }

  // 401 on an authenticated call: refresh once, then replay the request.
  if (res.status === 401 && allowRetry !== false && token && state.refreshToken) {
    if (await refreshSession()) return api(path, options, false);
  }

  if (!res.ok) {
    const err = apiError((data && (data.error || data.message)) || ('HTTP ' + res.status), res.status, data);
    throw err;
  }
  return data;
}

function apiError(message, status, data) {
  const err = new Error(message);
  err.status = status;
  err.data = data;
  return err;
}

// Turn SNAKE_CASE codes into something a human can act on.
const ERROR_TEXT = {
  RATE_LIMITED: 'Too many codes requested. Wait a few minutes and try again.',
  MAX_ATTEMPTS: 'Too many wrong codes - request a new one.',
  EXPIRED_OR_INVALID: 'That code has expired. Request a new one.',
  MISMATCH: "That code doesn't match.",
  REGISTRATION_EXPIRED: 'Sign-up timed out. Start again.',
  NUMBER_ALREADY_REGISTERED: 'That number already has an account - try signing in.',
  NUMBER_ALREADY_BOUND: 'That number is already linked to an account.',
  NUMBER_PENDING_OTHER: 'That number is pending on another account.',
  MAX_PHONES_REACHED: "You've hit the maximum number of phone numbers.",
  MUST_HAVE_LOGIN_NUMBER: 'At least one number must stay able to sign in.',
  DEVICE_BOUND_TO_ANOTHER_ACCOUNT: 'This browser is already bound to a different account.',
  ACCOUNT_INACTIVE: 'This account is not active.',
  ALREADY_EXISTS: 'That value is already taken.',
  CONTACT_NOT_FOUND: "No account with that handle.",
  CANNOT_ADD_SELF: "You can't add yourself as a trusted contact.",
  ALREADY_TRUSTED: "They're already a trusted contact.",
  RECOVERY_IN_PROGRESS: 'A recovery attempt is already running.',
  NO_TRUSTED_DEVICES: 'You have no trusted devices.',
  NO_SECONDARY_NUMBER: 'You have no secondary verified number.',
  INSUFFICIENT_TRUSTED_CONTACTS: 'Not enough trusted contacts for this tier.',
  INVALID_REFRESH_TOKEN: 'Your session expired. Sign in again.',
  REFRESH_TOKEN_EXPIRED: 'Your session expired. Sign in again.',
  STEP_UP_REQUIRED: 'Extra verification required.',
  MESSAGE_EMPTY: 'Write something first.',
  MESSAGE_TOO_LONG: 'That message is too long.',
  THREAD_NOT_FOUND: 'That conversation no longer exists.',
  SEND_FAILED: 'The carrier would not accept that message.',
  DEV_MODE_ONLY: 'That is only available in dev mode.',
  RATE_LIMITED_SMS: 'You have sent a lot of texts recently. Try again later.',
};
function friendly(err) {
  if (!err) return 'Something went wrong.';
  return ERROR_TEXT[err.message] || err.message || 'Something went wrong.';
}

/* ============================================================
   session clock
   ============================================================ */
function startSessionClock() {
  clearInterval(state.sessionTimer);
  const pill = $('#session-pill');
  if (!state.token || !state.expiresAt) { pill.hidden = true; return; }
  pill.hidden = false;

  const tick = () => {
    const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
    if (left <= 0) { pill.textContent = 'session expired'; pill.className = 'pill warn'; return; }
    const m = Math.floor(left / 60), s = left % 60;
    pill.textContent = 'session ' + m + ':' + String(s).padStart(2, '0');
    pill.className = 'pill' + (left < 120 ? ' warn' : '');
  };
  tick();
  state.sessionTimer = setInterval(tick, 1000);
}

function showView(which) {
  $('#view-auth').hidden = which !== 'auth';
  $('#view-app').hidden = which !== 'app';
  $('#btn-logout').hidden = which !== 'app';
  $('#who').textContent = which === 'app' && state.account ? '@' + state.account.handle : '';
}

function signOut(notify, message) {
  const token = state.token;
  clearInterval(state.pollTimer); state.pollTimer = null;
  clearInterval(state.sessionTimer); state.sessionTimer = null;
  clearTimeout(state.refreshTimer); state.refreshTimer = null;
  stopEvents();

  state.token = null;
  state.refreshToken = null;
  state.expiresAt = 0;
  state.account = null;
  state.recoveryCodesRemaining = null;
  state.inbox = { messages: [], total: 0, limit: 20, offset: 0, status: '', category: '', q: '', selected: [], loading: false };

  ['pm.token', 'pm.refresh', 'pm.expiresAt', 'pm.account', 'pm.rcLeft'].forEach(store.del);
  $('#session-pill').hidden = true;
  $('#unread-badge').hidden = true;
  $('#bulkbar').hidden = true;

  showView('auth');
  showStep(1);
  // Revoke server-side using the token we just cleared locally.
  if (token) api('/auth/logout', { method: 'POST', body: {}, token: token, allowRetry: false }).catch(() => {});
  if (message) toast(message, true);
  else if (notify !== false) toast('Signed out');
}

/* ============================================================
   auth flow
   ============================================================ */
function showStep(n) {
  state.step = n;
  $('#p-phone').hidden = n !== 1;
  $('#p-otp').hidden = n !== 2;
  $('#p-reg').hidden = n !== 3;

  const before = n - 1;
  $('#st1').className = 'step' + (n === 1 ? ' on' : before >= 1 ? ' done' : '');
  $('#st2').className = 'step' + (n === 2 ? ' on' : before >= 2 ? ' done' : '');
  $('#st3').className = 'step' + (n === 3 ? ' on' : '');

  if (n === 2) setTimeout(() => $('#in-otp').focus(), 60);
  if (n === 3) setTimeout(() => $('#in-handle').focus(), 60);
}

function startOtpTimer() {
  clearInterval(state.otpTimer);
  const tick = () => {
    const left = Math.max(0, Math.round((state.otpExpiresAt - Date.now()) / 1000));
    const el = $('#otp-timer');
    if (left <= 0) {
      el.textContent = 'expired';
      clearInterval(state.otpTimer);
    } else {
      el.textContent = 'expires in ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0');
    }
  };
  tick();
  state.otpTimer = setInterval(tick, 1000);
}

// The countdown value and the interval handle must be separate - storing the
// handle in the same variable made the counter start from the handle's id and
// expire after a few seconds instead of running the full cooldown.
let resendTimer = null;
function startResendTimer() {
  clearInterval(resendTimer);
  const btn = $('#btn-resend');
  btn.disabled = true;
  let left = 30;
  const tick = () => {
    if (left <= 0) {
      clearInterval(resendTimer);
      resendTimer = null;
      btn.disabled = false;
      $('#resend-note').textContent = '';
      return;
    }
    $('#resend-note').textContent = 'You can request another in ' + left + 's';
    left -= 1;
  };
  tick();
  resendTimer = setInterval(tick, 1000);
}

async function sendCode() {
  const phone = $('#in-phone').value.trim();
  if (!phone) return toast('Enter a phone number', true);

  const btn = $('#btn-start');
  busy(btn, true);
  try {
    const r = await api('/auth/phone/start', {
      method: 'POST',
      body: { phone: phone, channel: $('#sel-channel').value },
      allowRetry: false,
    });
    onChallenge(r, phone);
    toast('Code sent');
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Send code');
  }
}

function onChallenge(r, phone) {
  state.challengeId = r.challengeId;
  state.phone = phone;
  state.channel = r.channel || 'SMS';
  state.devOtp = r.otp || null;
  state.otp = '';
  state.needsStepUp = false;
  state.otpExpiresAt = Date.now() + (r.expiresIn || 300) * 1000;

  $('#otp-phone').textContent = phone;
  $('#otp-channel').textContent = state.channel === 'VOICE' ? 'a voice call' : state.channel;
  $('#in-otp').value = '';
  $('#stepup').hidden = true;
  $('#in-stepup').value = '';

  // Dev mode returns the code in the response so nobody has to tail server.log.
  $('#dev-otp').hidden = !state.devOtp;
  if (state.devOtp) $('#dev-otp-val').textContent = state.devOtp;

  showStep(2);
  startOtpTimer();
  startResendTimer();
}

async function verifyCode(stepUpCode) {
  const otp = $('#in-otp').value.trim();
  if (!/^\d{6}$/.test(otp)) return toast('Enter the 6-digit code', true);
  if (state.needsStepUp && !stepUpCode) return toast('Enter your recovery code', true);

  const btn = state.needsStepUp ? $('#btn-stepup') : $('#btn-verify');
  busy(btn, true);
  try {
    const body = {
      challengeId: state.challengeId,
      otp: otp,
      deviceInfo: { deviceId: deviceKey(state.phone), deviceKey: deviceKey(state.phone), platform: 'web', name: browserName() },
    };
    if (stepUpCode) body.stepUp = { method: 'RECOVERY_CODE', code: stepUpCode.trim().toUpperCase() };

    const r = await api('/auth/phone/verify', { method: 'POST', body: body, allowRetry: false });

    if (r.needsRegistration) {
      state.otp = otp;
      showStep(3);
      return;
    }
    clearInterval(state.otpTimer);
    await onSignedIn(r, false);
  } catch (e) {
    if (e.status === 403 && e.data && e.data.error === 'STEP_UP_REQUIRED') {
      state.needsStepUp = true;
      state.otp = otp;
      $('#stepup').hidden = false;
      setTimeout(() => $('#in-stepup').focus(), 60);
      toast('Extra verification required', true);
      return;
    }
    let msg = friendly(e);
    if (e.data && typeof e.data.attemptsLeft === 'number') msg += ' (' + e.data.attemptsLeft + ' left)';
    toast(msg, true);
  } finally {
    busy(btn, false);
  }
}

async function registerAccount() {
  const handle = $('#in-handle').value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
  const name = $('#in-name').value.trim();
  if (!handle) return toast('Pick a handle', true);
  if (!name) return toast('Enter a display name', true);

  const btn = $('#btn-register');
  busy(btn, true);
  try {
    const r = await api('/auth/register/complete', {
      method: 'POST',
      allowRetry: false,
      body: {
        challengeId: state.challengeId,
        otp: state.otp || $('#in-otp').value.trim(),
        handle: handle,
        displayName: name,
        deviceInfo: { deviceId: deviceKey(state.phone), deviceKey: deviceKey(state.phone), platform: 'web', name: browserName() },
      },
    });
    clearInterval(state.otpTimer);
    await onSignedIn(r, true);
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Create account');
  }
}

async function onSignedIn(r, isNew) {
  setTokens(r.tokens);
  state.account = r.account;
  state.recoveryCodesRemaining = isNew && r.recoveryCodes ? r.recoveryCodes.length : state.recoveryCodesRemaining;
  store.set('pm.account', r.account);
  store.set('pm.rcLeft', state.recoveryCodesRemaining);

  showView('app');
  showStep(1);
  startSessionClock();
  scheduleRefresh();
  startPolling();
  connectEvents();
  loadThreads();

  if (isNew && r.recoveryCodes && r.recoveryCodes.length) {
    state.recoveryCodes = r.recoveryCodes;
    store.set('pm.rc', r.recoveryCodes);
    showRecoveryCodeBanner();
  }

  toast(isNew ? 'Account created' : 'Signed in');
  await loadAccount();
  setTab(state.tab);
}

// One key per phone number: the backend binds a deviceKey to exactly one
// account, so a browser holding several numbers needs a key per number.
function deviceKey(phone) {
  const key = 'pm.deviceKey:' + (phone || 'anon');
  let k = store.get(key, null);
  if (!k) {
    k = (window.crypto && crypto.randomUUID && crypto.randomUUID()) ||
        'pk-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set(key, k);
  }
  return k;
}

function browserName() {
  const ua = navigator.userAgent;
  let os = 'Unknown OS';
  if (/Windows/i.test(ua)) os = 'Windows';
  else if (/Mac OS X/i.test(ua)) os = 'macOS';
  else if (/Android/i.test(ua)) os = 'Android';
  else if (/iPhone|iPad/i.test(ua)) os = 'iOS';
  else if (/Linux/i.test(ua)) os = 'Linux';
  return os + ' browser';
}

/* ============================================================
   account data
   ============================================================ */
async function loadAccount() {
  try {
    const r = await api('/auth/me');
    state.account = r.account;
    state.recoveryCodesRemaining = r.recoveryCodesRemaining;
    store.set('pm.account', r.account);
    store.set('pm.rcLeft', r.recoveryCodesRemaining);

    renderProfile(r.account);
    renderFactorBanner(r.recoveryCodesRemaining);
  } catch (e) {
    toast(friendly(e), true);
  }
}

function renderProfile(a) {
  if (!a) return;
  const bindings = a.phoneBindings || [];
  const devices = a.devices || [];
  const row = (k, v) => '<dt>' + k + '</dt><dd>' + v + '</dd>';
  $('#kv-profile').innerHTML =
    row('Handle', '@' + esc(a.handle)) +
    row('Display name', esc(a.displayName || '—')) +
    row('Status', '<span class="badge ' + (a.status === 'ACTIVE' ? 'green' : 'muted') + '">' + esc(a.status) + '</span>') +
    row('Numbers', String(bindings.length)) +
    row('Devices', String(devices.length) + (devices.filter((d) => d.isTrusted).length ? ' (' + devices.filter((d) => d.isTrusted).length + ' trusted)' : '')) +
    row('Created', esc(dt(a.createdAt))) +
    row('Last active', esc(ago(a.lastActiveAt))) +
    row('User ID', esc(a.id));
}

function renderFactorBanner(remaining) {
  $('#factor-banner').hidden = remaining !== 0;
  $('#rc-remaining').textContent = remaining === null ? '—' : remaining + ' left';
  $('#rc-remaining').className = 'badge ' + (remaining === 0 ? 'red' : remaining !== null && remaining <= 3 ? 'amber' : 'blue');
}

function renderRecoveryCodes(codes) {
  $('#rc-codes').innerHTML = codes
    .map((c) => '<div class="code">' + esc(c) + '</div>')
    .join('');
}

/* ---------------- phones ---------------- */
async function loadPhones() {
  const box = $('#phone-list');
  box.innerHTML = skeleton(2);
  try {
    const r = await api('/phones');
    const list = (r.phones || []).filter(Boolean);
    if (!list.length) { box.innerHTML = emptyState('No phone numbers linked yet.', 'Add one to sign in from more places.'); return; }

    const loginCount = list.filter((p) => (p.roleFlags || []).includes('LOGIN')).length;
    box.innerHTML = list.map((p) => {
      const roles = p.roleFlags || [];
      const isLast = p.isPrimary;
      const roleChecks = ['LOGIN', 'RECOVERY', 'NOTIFICATIONS'].map((r) =>
        '<label class="check"><input type="checkbox" data-phone-role="' + p.id + '" value="' + r + '"' +
        (roles.includes(r) ? ' checked' : '') + '> ' + r.charAt(0) + r.slice(1).toLowerCase() + '</label>'
      ).join('');

      return '<div class="item" data-phone="' + p.id + '">' +
        '<div class="item-h">' +
          '<span class="item-title">' + esc(p.maskedNumber || 'Hidden') + '</span>' +
          (p.isPrimary ? '<span class="badge green">primary</span>' : '') +
          '<span class="badge ' + (p.status === 'ACTIVE' ? 'green' : 'amber') + '">' + esc(p.status) + '</span>' +
          (p.lineType && p.lineType !== 'UNKNOWN' ? '<span class="badge muted">' + esc(p.lineType) + '</span>' : '') +
          '<div class="spacer"></div>' +
          (p.isPrimary ? '' : '<button class="sm" data-phone-act="primary">Make primary</button>') +
          '<button class="sm danger" data-phone-act="remove">Remove</button>' +
        '</div>' +
        '<div class="item-sub">' +
          (p.country ? 'Country ' + esc(p.country) : 'Country unknown') +
          (p.carrier ? ' &middot; ' + esc(p.carrier) : '') +
          ' &middot; verified ' + esc(ago(p.verifiedAt)) +
        '</div>' +
        '<div class="checks">' + roleChecks + '</div>' +
      '</div>';
    }).join('');

    if (loginCount === 1) {
      box.insertAdjacentHTML('beforeend',
        '<p class="small muted" style="margin-top:10px">This is your only sign-in number &mdash; it can\'t be removed or have the sign-in role removed.</p>');
    }
  } catch (e) {
    box.innerHTML = emptyState('Could not load numbers', friendly(e));
  }
}

/* ---------------- devices ---------------- */
async function loadDevices() {
  const box = $('#device-list');
  box.innerHTML = skeleton(2);
  try {
    const r = await api('/auth/me');
    const list = (r.account && r.account.devices) || [];
    if (!list.length) { box.innerHTML = emptyState('No devices yet', 'One is created the first time you sign in.'); return; }

    box.innerHTML = list.map((d) => {
      const badge = d.isTrusted
        ? '<span class="badge green">trusted</span>'
        : '<span class="badge muted">unverified</span>';
      return '<div class="item" data-device="' + d.id + '">' +
        '<div class="item-h">' +
          '<span class="item-title">' + esc(d.name || d.platform || 'device') + '</span>' + badge +
          (d.trustLevel && d.trustLevel !== 'UNVERIFIED' ? '<span class="badge blue">' + esc(d.trustLevel.toLowerCase().replace('_', ' ')) + '</span>' : '') +
          '<div class="spacer"></div>' +
          (d.isTrusted ? '' : '<button class="sm" data-device-act="trust">Trust</button>') +
          '<button class="sm danger" data-device-act="revoke">Revoke</button>' +
        '</div>' +
        '<div class="item-sub">Platform ' + esc(d.platform || 'unknown') + ' &middot; last seen ' + esc(ago(d.lastSeenAt)) + '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    box.innerHTML = emptyState('Could not load devices', friendly(e));
  }
}

/* ---------------- passkeys ---------------- */
async function loadPasskeys() {
  const box = $('#passkey-list');
  box.innerHTML = skeleton(1);
  try {
    const r = await api('/passkeys');
    const list = r.passkeys || [];
    if (!list.length) {
      box.innerHTML = emptyState('No passkeys registered',
        'A passkey lets you sign in with your fingerprint or face instead of a text code.');
      return;
    }
    box.innerHTML = list.map((k) =>
      '<div class="item" data-passkey="' + k.id + '">' +
        '<div class="item-h">' +
          '<span class="item-title">' + esc(k.name || 'passkey') + '</span>' +
          '<div class="spacer"></div>' +
          '<button class="sm danger" data-passkey-act="revoke">Revoke</button>' +
        '</div>' +
        '<div class="item-sub">Added ' + esc(dt(k.createdAt)) +
          (k.lastUsedAt ? ' &middot; last used ' + esc(ago(k.lastUsedAt)) : ' &middot; never used') + '</div>' +
      '</div>').join('');
  } catch (e) {
    box.innerHTML = emptyState('Could not load passkeys', friendly(e));
  }
}

/* ============================================================
   security
   ============================================================ */
async function generateNewCodes() {
  const ok = await confirmDialog(
    'Generate a new set?',
    'You will get 10 fresh codes. Your existing unused codes keep working.',
    'Generate'
  );
  if (!ok) return;
  try {
    const r = await api('/auth/recovery-codes', { method: 'POST', body: {} });
    const codes = r.codes || [];
    state.recoveryCodes = codes;
    store.set('pm.rc', codes);
    showRecoveryCodeBanner();
    await loadAccount();
    toast('Generated ' + codes.length + ' new codes');
  } catch (e) {
    toast(friendly(e), true);
  }
}

async function testRecoveryCode() {
  const input = $('#in-verify-code');
  const code = input.value.trim().toUpperCase();
  if (!code) return toast('Enter a code to test', true);

  const btn = $('#btn-verify-code');
  busy(btn, true);
  try {
    const r = await api('/recovery/code/verify', { method: 'POST', body: { code: code } });
    if (r.valid) {
      toast('Code accepted — and now used up', true);
      input.value = '';
      await loadAccount();
    } else {
      toast('That code is not valid', true);
    }
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Test code');
  }
}

async function revokeAllSessions() {
  const ok = await confirmDialog(
    'Sign out everywhere?',
    'Every session on every device ends immediately, including this one. You will need to sign in again.',
    'Revoke all'
  );
  if (!ok) return;
  try {
    await api('/auth/revoke-all', { method: 'POST', body: {} });
  } catch (e) {
    toast(friendly(e), true);
  }
  signOut(true, 'All sessions revoked — sign in again');
}

async function loadRecovery() {
  const box = $('#recovery-status');
  box.innerHTML = skeleton(1);
  try {
    const r = await api('/recovery/status');
    const rec = r.recovery;
    if (!rec) {
      box.innerHTML = '<p class="sub" style="margin:14px 0 0">No recovery attempt in progress.</p>';
    } else {
      const row = (k, v) => '<dt>' + k + '</dt><dd>' + v + '</dd>';
      const daysLeft = rec.waitingUntil
        ? Math.max(0, Math.ceil((new Date(rec.waitingUntil) - Date.now()) / 86400000))
        : null;
      box.innerHTML =
        '<dl class="kv" style="margin-top:14px">' +
          row('Tier', '<span class="badge blue">' + esc(rec.tier) + '</span>') +
          row('Status', '<span class="badge ' + (rec.status === 'INITIATED' ? 'amber' : 'blue') + '">' + esc(rec.status) + '</span>') +
          row('Trigger', esc(rec.trigger || '—')) +
          row('Started', esc(dt(rec.initiatedAt))) +
          (daysLeft !== null ? row('Waiting period', daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ' remaining') : '') +
          row('Attempt ID', esc(rec.id)) +
        '</dl>';
    }
  } catch (e) {
    box.innerHTML = emptyState('Could not load recovery status', friendly(e));
  }
  loadContacts();
}

async function initiateRecovery() {
  const tier = $('#sel-tier').value;
  const btn = $('#btn-initiate-recovery');
  busy(btn, true);
  try {
    const r = await api('/recovery/initiate', { method: 'POST', body: { tier: tier, trigger: 'USER_INITIATED' } });
    $('#recovery-result').innerHTML = 'Started <b>' + esc(tier) + '</b> — attempt <code class="mono">' + esc(r.attemptId || '') + '</code>. Alerts have gone out to your other channels.';
    toast('Recovery initiated');
    await loadRecovery();
  } catch (e) {
    $('#recovery-result').textContent = friendly(e);
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Initiate');
  }
}

async function loadContacts() {
  const box = $('#contact-list');
  box.innerHTML = skeleton(1);
  try {
    const r = await api('/recovery/contacts');
    const list = r.contacts || [];
    if (!list.length) { box.innerHTML = emptyState('No trusted contacts', 'Add someone you trust to vouch for you.'); return; }
    box.innerHTML = list.map((c) =>
      '<div class="item" data-contact="' + c.id + '">' +
        '<div class="item-h">' +
          '<span class="item-title">@' + esc(c.contactHandle || 'unknown') + '</span>' +
          (c.confirmedAt ? '<span class="badge green">confirmed</span>' : '<span class="badge amber">pending</span>') +
          '<div class="spacer"></div>' +
          '<button class="sm danger" data-contact-act="remove">Remove</button>' +
        '</div>' +
        '<div class="item-sub">' + esc(c.contactName || 'Unnamed') + ' &middot; added ' + esc(ago(c.addedAt)) + '</div>' +
      '</div>').join('');
  } catch (e) {
    box.innerHTML = emptyState('Could not load contacts', friendly(e));
  }
}

async function addContact() {
  const input = $('#in-contact');
  const handle = input.value.trim().replace(/^@/, '');
  if (!handle) return toast('Enter a handle', true);
  const btn = $('#btn-add-contact');
  busy(btn, true);
  try {
    await api('/recovery/contacts', { method: 'POST', body: { contactHandle: handle } });
    input.value = '';
    toast('Added @' + handle);
    await loadContacts();
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Add');
  }
}

/* ============================================================
   inbox
   ============================================================ */
function skeleton(n) {
  return Array.from({ length: n || 1 }, () =>
    '<div class="skeleton"><div class="bar w1"></div><div class="bar w2"></div><div class="bar w3"></div></div>'
  ).join('');
}

function emptyState(title, hint) {
  return '<div class="empty"><div class="big">&#128231;</div><b>' + esc(title) + '</b>' +
    (hint ? '<div class="small" style="margin-top:6px">' + esc(hint) + '</div>' : '') + '</div>';
}

async function loadInbox(append) {
  if (state.inbox.loading) return;
  state.inbox.loading = true;

  const box = $('#msg-list');
  if (!append) box.innerHTML = skeleton(3);

  const searching = state.inbox.q.length > 0;
  const limit = searching ? 200 : state.inbox.limit;
  const offset = append ? state.inbox.messages.length : 0;

  const params = ['limit=' + limit, 'offset=' + offset];
  if (state.inbox.status) params.push('status=' + encodeURIComponent(state.inbox.status));
  if (state.inbox.category) params.push('category=' + encodeURIComponent(state.inbox.category));

  try {
    const r = await api('/inbox?' + params.join('&'));
    let messages = r.messages || [];

    if (searching) {
      const q = state.inbox.q.toLowerCase();
      messages = messages.filter((m) =>
        (m.subject || '').toLowerCase().includes(q) || (m.body || '').toLowerCase().includes(q));
    }

    state.inbox.total = r.total || 0;
    state.inbox.messages = append ? state.inbox.messages.concat(messages) : messages;
    state.inbox.selected = state.inbox.selected.filter((id) =>
      state.inbox.messages.some((m) => m.id === id));

    renderMessages();
    updateBulkBar();
    await refreshUnread();
    loadCategories();
  } catch (e) {
    box.innerHTML = emptyState('Could not load your inbox', friendly(e));
  } finally {
    state.inbox.loading = false;
  }
}

function renderMessages() {
  const box = $('#msg-list');
  const list = state.inbox.messages;
  if (!list.length) {
    box.innerHTML = state.inbox.q
      ? emptyState('No matches', 'Nothing in the loaded messages matches "' + state.inbox.q + '".')
      : emptyState('Your inbox is empty', 'Use "Send test message" to drop something in.');
    $('#msg-more').hidden = true;
    return;
  }

  box.innerHTML = list.map((m) => {
    const unread = m.status === 'UNREAD';
    const sel = state.inbox.selected.indexOf(m.id) !== -1;
    const when = m.createdAt ? new Date(m.createdAt) : null;
    const stamp = when ? (when.toDateString() === new Date().toDateString()
      ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : when.toLocaleDateString([], { month: 'short', day: 'numeric' })) : '';

    const meta = [
      m.type ? ['Type', m.type] : null,
      m.category ? ['Category', m.category] : null,
      m.priority ? ['Priority', m.priority] : null,
      m.sourceType ? ['Source', m.sourceType + (m.sourceId ? ' #' + m.sourceId : '')] : null,
      m.payload && m.payload.deepLink ? ['Link', m.payload.deepLink] : null,
      ['Created', dt(m.createdAt)],
    ].filter(Boolean);

    return '<div class="msg' + (unread ? ' unread' : ' read') + '" data-id="' + m.id + '">' +
      '<div class="msg-h">' +
        '<input type="checkbox" data-msg-select" aria-label="Select message"' + (sel ? ' checked' : '') + '>' +
        '<span class="dot' + (unread ? ' unread' : '') + '"></span>' +
        '<div class="msg-main">' +
          '<div class="msg-sub">' + esc(m.subject || '(no subject)') + '</div>' +
          '<div class="msg-body">' + esc(m.body || '') + '</div>' +
        '</div>' +
        '<span class="chip ' + esc(m.priority || 'NORMAL') + '">' + esc(m.priority || 'NORMAL') + '</span>' +
        '<span class="chip ' + esc(m.category || 'SYSTEM') + '">' + esc(m.category || 'SYSTEM') + '</span>' +
        // "All messages" includes archived rows, so they need to be marked -
        // otherwise an archived message is indistinguishable from a read one.
        (m.status === 'ARCHIVED' ? '<span class="chip ARCHIVED">archived</span>' : '') +
        '<span class="msg-t">' + esc(stamp) + '</span>' +
      '</div>' +
      '<div class="msg-x">' +
        '<div class="full">' + esc(m.body || '') + '</div>' +
        (m.payload ? '<pre class="payload">' + esc(JSON.stringify(m.payload, null, 2)) + '</pre>' : '') +
        '<dl class="meta">' + meta.map((r) => '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>').join('') + '</dl>' +
        '<div class="acts">' +
          (unread ? '<button class="sm" data-msg-act="read">Mark read</button>' : '') +
          (m.status !== 'ARCHIVED' ? '<button class="sm" data-msg-act="archive">Archive</button>' : '') +
          '<button class="sm danger" data-msg-act="delete">Delete</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');

  const canMore = state.inbox.messages.length < state.inbox.total && !state.inbox.q;
  $('#msg-more').hidden = !canMore;
}

function updateBulkBar() {
  const n = state.inbox.selected.length;
  $('#bulkbar').hidden = n === 0;
  $('#bulk-count').textContent = n + ' selected';
}

async function refreshUnread() {
  try {
    const r = await api('/inbox/unread-count');
    const badge = $('#unread-badge');
    badge.textContent = String(r.count);
    badge.hidden = !r.count;
  } catch (e) { /* non-fatal */ }
}

function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = setInterval(() => {
    if (document.hidden || !state.token) return;
    refreshUnread();
  }, 20000);
}

async function sendTestMessage() {
  const btn = $('#btn-test-msg');
  busy(btn, true);
  try {
    // Categories and types below are the exact Prisma enum values. MARKETING is
    // deliberately omitted: the service drops it without marketing consent.
    const picks = [
      { type: 'SECURITY_ALERT', category: 'SECURITY', subject: 'New sign-in from a new device', body: 'We noticed a sign-in from a browser we had not seen before. If this was not you, revoke the device.', priority: 'HIGH' },
      { type: 'RECEIPT_INVOICE', category: 'BILLING', subject: 'Receipt #4471', body: 'Your payment of $24.00 was received. Thanks for your business.', priority: 'NORMAL' },
      { type: 'TRANSACTIONAL', category: 'TRANSACTION', subject: 'Your parcel is on the way', body: 'Tracking number 1Z999AA10123456784. Expected tomorrow.', priority: 'NORMAL' },
      { type: 'LEGAL_NOTICE', category: 'LEGAL', subject: 'Updated terms of service', body: 'We changed the terms. Review them and acknowledge before the effective date.', priority: 'HIGH' },
      {
        type: 'SYSTEM', category: 'SYSTEM', subject: 'Welcome to PhoneMail',
        body: 'Your account is ready. Add a second number so you can always get back in.',
        payload: { deepLink: '/account', cta: 'Add a backup number', nested: { note: 'structured payloads render here' } },
        priority: 'NORMAL',
      },
    ];
    const pick = picks[Math.floor(Math.random() * picks.length)];
    await api('/inbox/test', { method: 'POST', body: pick });
    toast('Test message sent');
    $('#f-status').value = '';
    $('#f-category').value = '';
    state.inbox.status = ''; state.inbox.category = '';
    await loadInbox(false);
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Send test message');
  }
}

async function bulkAction(action) {
  const ids = state.inbox.selected.slice();
  if (!ids.length) return;
  const labels = { read: 'Mark read', archive: 'Archive', delete: 'Delete' };
  if (action === 'delete') {
    const ok = await confirmDialog('Delete ' + ids.length + ' message(s)?', 'This cannot be undone.', 'Delete');
    if (!ok) return;
  }
  try {
    const r = await api('/inbox/bulk', { method: 'POST', body: { action: action, messageIds: ids } });
    toast(labels[action] + ' — ' + (r.count || ids.length) + ' message(s)');
    state.inbox.selected = [];
    await loadInbox(false);
  } catch (e) {
    toast(friendly(e), true);
  }
}

async function loadCategories() {
  try {
    const r = await api('/inbox/summary/categories');
    const seen = {};
    (r.summary || []).forEach((s) => { seen[s.category] = true; });
    state.categories = Object.keys(seen).sort();
    const sel = $('#f-category');
    const current = sel.value;
    sel.innerHTML = '<option value="">All categories</option>' +
      state.categories.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    sel.value = current;
  } catch (e) { /* non-fatal */ }
}

/* ============================================================
   live updates (SSE)
   ============================================================ */

/*
 * EventSource cannot send an Authorization header, and a bearer token in the
 * query string would end up in access logs and referrers. So the stream is read
 * with fetch() and the frames are parsed by hand.
 */
function connectEvents() {
  if (!state.token) return;
  stopEvents();

  const controller = new AbortController();
  state.events = { controller: controller, timer: null, live: false, attempt: 0 };

  (async () => {
    try {
      const res = await fetch('/events', {
        headers: { Authorization: 'Bearer ' + state.token, Accept: 'text/event-stream' },
        signal: controller.signal,
      });
      if (!res.ok || !res.body) throw new Error('stream status ' + res.status);

      setLiveState(true);
      state.events.attempt = 0;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let split;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          handleEventFrame(buffer.slice(0, split));
          buffer = buffer.slice(split + 2);
        }
      }
      throw new Error('stream closed');
    } catch (e) {
      if (controller.signal.aborted) return;
      setLiveState(false);
      // Back off, but only while there is still a session to reconnect with.
      if (state.token) {
        state.events.attempt = Math.min(state.events.attempt + 1, 5);
        state.events.timer = setTimeout(connectEvents, 1000 * Math.pow(2, state.events.attempt - 1));
      }
    }
  })();
}

function stopEvents() {
  if (!state.events) return;
  clearTimeout(state.events.timer);
  if (state.events.controller) state.events.controller.abort();
  state.events = null;
  if (state.token) {
    // The stream is gone but the session may not be - say so rather than
    // silently claiming the user is offline.
    const pill = $('#live-pill');
    if (pill) { pill.hidden = false; pill.className = 'pill warn'; pill.innerHTML = '<span class="dotpulse"></span>offline'; }
  } else {
    setLiveState(false);
    const pill = $('#live-pill');
    if (pill) pill.hidden = true;
  }
}

function setLiveState(live) {
  // Record it: the conversation header re-renders on every message, and without
  // this the indicator snapped back to "reconnecting" each time.
  if (state.events) state.events.live = live;

  const pill = $('#live-pill');
  if (pill) {
    pill.hidden = !live;
    pill.className = 'pill' + (live ? '' : ' warn');
    pill.innerHTML = '<span class="dotpulse"></span>' + (live ? 'live' : 'reconnecting');
  }
}

function handleEventFrame(frame) {
  let name = null;
  let data = null;
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) name = line.slice(6).trim();
    else if (line.startsWith('data:')) data = line.slice(5).trim();
    // Lines starting with ':' are comments/heartbeats, 'retry:' is handled by us.
  }
  if (!name || data === null) return;

  let payload = null;
  try { payload = JSON.parse(data); } catch (e) { return; }

  if (name === 'ready') { setLiveState(true); return; }
  if (name === 'sms') return onMessageEvent(payload);
  if (name === 'thread') return onThreadEvent(payload);
  if (name === 'thread-deleted') return onThreadDeleted(payload);
}

/* ============================================================
   text messages
   ============================================================ */

function onMessageEvent(payload) {
  const message = payload && payload.message;
  if (!message) return;

  // "Active" is not enough on its own: the thread can still be the selected one
  // while the user has moved to another tab, and quietly marking that read
  // meant an arriving text never showed up in the badge or fired a toast.
  const threadOnScreen = state.tab === 'text' && state.sms.activeId === message.threadId;

  if (threadOnScreen) {
    const i = state.sms.messages.findIndex((m) => m.id === message.id);
    if (i === -1) state.sms.messages.push(message);
    else state.sms.messages[i] = message;
    state.sms.messages.sort(byCreatedAt);
    renderBubbles();
    scrollSmsToEnd();
    if (message.direction === 'INBOUND') quietMarkRead(message.threadId);
    return;
  }

  // Not on screen: let the user know. The `thread` event that follows carries
  // the new unreadCount and updates the badge.
  if (message.direction === 'INBOUND') {
    const thread = state.sms.threads.find((t) => t.id === message.threadId);
    toast('New text' + (thread ? ' from ' + (thread.label || thread.peer) : ''));
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* unsupported */ }
  }
}

function onThreadEvent(thread) {
  if (!thread || !thread.id) return;
  const i = state.sms.threads.findIndex((t) => t.id === thread.id);
  if (i === -1) state.sms.threads.unshift(thread);
  else state.sms.threads[i] = Object.assign({}, state.sms.threads[i], thread);
  state.sms.threads.sort((a, b) => new Date(b.lastMessageAt) - new Date(a.lastMessageAt));

  if (state.tab === 'text') renderThreads();
  updateTextBadge();

  if (state.sms.activeId === thread.id) {
    state.sms.active = Object.assign({}, state.sms.active || {}, thread);
    renderSmsHeader();
  }
}

function onThreadDeleted(payload) {
  if (!payload || !payload.threadId) return;
  state.sms.threads = state.sms.threads.filter((t) => t.id !== payload.threadId);
  if (state.sms.activeId === payload.threadId) {
    state.sms.activeId = null;
    state.sms.active = null;
    state.sms.messages = [];
    document.getElementById('sms-layout').classList.remove('picking');
  }
  if (state.tab === 'text') { renderThreads(); renderConversation(); }
  updateTextBadge();
}

const byCreatedAt = (a, b) => new Date(a.createdAt) - new Date(b.createdAt);

function updateTextBadge() {
  const total = state.sms.threads.reduce((n, t) => n + (t.unreadCount || 0), 0);
  const badge = $('#text-unread-badge');
  badge.textContent = String(total);
  badge.hidden = !total;
}

async function loadThreads() {
  try {
    const r = await api('/messages/threads');
    state.sms.threads = r.threads || [];
    state.sms.maxBody = (r.limits && r.limits.maxBodyLength) || 1600;
    state.sms.devMode = !!r.devMode;

    if (state.sms.activeId) {
      const found = state.sms.threads.find((t) => t.id === state.sms.activeId);
      if (found) state.sms.active = found;
    }
    renderThreads();
    updateTextBadge();
    if (!state.sms.activeId) renderConversation();
  } catch (e) {
    $('#sms-threads').innerHTML = emptyState('Could not load conversations', friendly(e));
  }
}

function renderThreads() {
  const box = $('#sms-threads');
  const q = state.sms.filter.toLowerCase();
  const list = state.sms.threads.filter((t) =>
    !q ||
    (t.label || '').toLowerCase().includes(q) ||
    (t.peer || '').includes(q) ||
    (t.lastPreview || '').toLowerCase().includes(q));

  if (!list.length) {
    box.innerHTML = q
      ? emptyState('No matches', 'Nothing in your conversations matches that.')
      : emptyState('No conversations yet', 'Hit New and text a number to begin.');
    return;
  }

  box.innerHTML = list.map((t) => {
    const initials = (t.label || t.peer || '?').replace(/[^0-9A-Za-z]/g, '').slice(-2).toUpperCase() || '?';
    const when = new Date(t.lastMessageAt);
    const sameDay = when.toDateString() === new Date().toDateString();
    return '<div class="sms-item' + (t.id === state.sms.activeId ? ' on' : '') +
        (t.unreadCount ? ' unread' : '') + '" data-thread="' + t.id + '">' +
      '<div class="avatar">' + esc(initials) + '</div>' +
      '<div class="sms-main">' +
        '<div class="sms-peer">' + esc(t.label || t.peer) + (t.isSelfNumber ? ' <span class="chip">you</span>' : '') + '</div>' +
        '<div class="sms-last">' + esc(t.lastPreview || 'No messages yet') + '</div>' +
      '</div>' +
      '<div class="sms-meta">' +
        '<span class="sms-when">' + esc(sameDay
          ? when.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : when.toLocaleDateString([], { month: 'short', day: 'numeric' })) + '</span>' +
        (t.unreadCount ? '<span class="pip">' + t.unreadCount + '</span>' : '') +
      '</div>' +
    '</div>';
  }).join('');
}

function renderConversation() {
  const view = $('#sms-view');

  if (!state.sms.activeId) {
    view.innerHTML =
      '<div class="start-card">' +
        '<div class="big">&#128172;</div>' +
        '<h2>Start a conversation</h2>' +
        '<p class="sub" style="margin:6px 0 0">Text any phone number. Replies land here automatically.</p>' +
        '<form id="sms-start">' +
          '<label for="in-start-to">Phone number (E.164)</label>' +
          '<input id="in-start-to" class="mono" type="tel" placeholder="+14155550199" spellcheck="false" autocomplete="off">' +
          '<label for="in-start-body">Message</label>' +
          '<textarea id="in-start-body" rows="3" placeholder="Write a message..." maxlength="1600" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid var(--border);background:var(--bg);color:var(--text);font:inherit;outline:none"></textarea>' +
          '<div class="row" style="margin-top:11px">' +
            '<span class="counter" id="start-count">0/' + state.sms.maxBody + '</span>' +
            '<div class="spacer"></div>' +
            '<button class="primary" type="submit" id="btn-start-send">Send</button>' +
          '</div>' +
        '</form>' +
      '</div>';
    return;
  }

  view.innerHTML =
    '<div class="sms-head" id="sms-head"></div>' +
    '<div class="sms-scroll-body" id="sms-body"></div>' +
    '<form class="composer" id="sms-form">' +
      '<textarea id="sms-input" rows="1" placeholder="Write a message..." maxlength="' + state.sms.maxBody + '" aria-label="Message"></textarea>' +
      '<div class="composer-foot">' +
        '<span class="counter" id="sms-count">0/' + state.sms.maxBody + '</span>' +
        '<div class="spacer"></div>' +
        (state.sms.devMode ? '<button type="button" class="sm ghost" data-act="simulate" title="Dev only: inject a reply as if the carrier delivered it">Simulate reply</button>' : '') +
        '<button class="primary" type="submit" id="btn-sms-send">Send</button>' +
      '</div>' +
    '</form>';

  renderSmsHeader();
  renderBubbles();
  scrollSmsToEnd();
}

function renderSmsHeader() {
  const head = $('#sms-head');
  if (!head || !state.sms.active) return;
  const t = state.sms.active;
  head.innerHTML =
    '<div class="avatar">' + esc((t.label || t.peer || '?').replace(/[^0-9A-Za-z]/g, '').slice(-2).toUpperCase() || '?') + '</div>' +
    '<div>' +
      '<div class="who2">' + esc(t.label || t.peer) + '</div>' +
      '<div class="sub2">' + esc(t.messageCount !== undefined ? t.messageCount + ' message' + (t.messageCount === 1 ? '' : 's') : '') + '</div>' +
    '</div>' +
    '<div class="spacer"></div>' +
    '<button class="sm ghost" data-act="rename">Rename</button>' +
    '<button class="sm ghost" data-act="archive">Archive</button>' +
    '<button class="sm danger" data-act="delete-thread">Delete</button>';
}

function renderBubbles() {
  const body = $('#sms-body');
  if (!body) return;
  const list = state.sms.messages;
  if (!list.length) {
    body.innerHTML = '<div class="ghostline" style="padding:40px 10px">No messages yet. Say something.</div>';
    return;
  }

  let html = '';
  let lastDay = null;
  for (const m of list) {
    const d = new Date(m.createdAt);
    if (d.toDateString() !== lastDay) {
      html += '<div class="daysep"><span>' + esc(dayLabel(d)) + '</span></div>';
      lastDay = d.toDateString();
    }
    html += bubbleHtml(m);
  }
  body.innerHTML = html;
}

function bubbleHtml(m) {
  const out = m.direction === 'OUTBOUND';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const cls = 'bubble ' + (out ? 'out' : 'in') +
    (m.status === 'QUEUED' ? ' pending' : '') +
    (m.status === 'FAILED' ? ' failed' : '');
  const meta = out
    ? '<span class="tick ' + m.status + '">' + tickGlyph(m.status) + '</span>' + (m.error ? '<span>' + esc(m.error) + '</span>' : '')
    : '';
  return '<div class="' + cls + '" data-id="' + m.id + '">' + esc(m.body) +
    '<div class="stamp">' + esc(time) + meta + '</div></div>';
}

function tickGlyph(status) {
  switch (status) {
    case 'QUEUED': return '⋯';
    case 'SENT': return '✓';
    case 'DELIVERED': return '✓✓';
    case 'READ': return '✓✓';
    case 'FAILED': return '!';
    default: return '';
  }
}

function dayLabel(d) {
  const today = new Date().toDateString() === d.toDateString();
  const yesterday = new Date(Date.now() - 86400000).toDateString() === d.toDateString();
  if (today) return 'Today';
  if (yesterday) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}

function scrollSmsToEnd() {
  const body = $('#sms-body');
  if (body) body.scrollTop = body.scrollHeight;
}

async function openThread(id) {
  state.sms.activeId = id;
  document.getElementById('sms-layout').classList.add('picking');
  renderThreads();
  renderConversation();

  try {
    const r = await api('/messages/threads/' + encodeURIComponent(id));
    state.sms.active = r.thread;
    state.sms.messages = r.messages || [];
    state.sms.hasMore = r.hasMore;
    renderConversation();

    if (r.thread.unreadCount > 0) {
      // Clear locally at once, reconcile from the pushed `thread` event.
      state.sms.active.unreadCount = 0;
      const t = state.sms.threads.find((x) => x.id === id);
      if (t) t.unreadCount = 0;
      renderThreads();
      updateTextBadge();
      quietMarkRead(id);
    }
  } catch (e) {
    $('#sms-view').innerHTML = '<div class="ghostline">' + esc(friendly(e)) + '</div>';
  }
}

function quietMarkRead(id) {
  api('/messages/threads/' + encodeURIComponent(id) + '/read', { method: 'POST', body: {} })
    .catch(() => { /* the badge is cosmetic; a failure here is not worth a toast */ });
}

function autosizeSms() {
  const input = $('#sms-input');
  if (!input) return;
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 190) + 'px';
  updateCounter(input.value.length);
}

function updateCounter(n) {
  const max = state.sms.maxBody;
  const el = $('#sms-count');
  if (el) {
    el.textContent = n + '/' + max;
    el.className = 'counter' + (n > max ? ' over' : n > max * 0.9 ? ' warn' : '');
  }
  const start = $('#start-count');
  if (start) {
    start.textContent = n + '/' + max;
    start.className = 'counter' + (n > max ? ' over' : n > max * 0.9 ? ' warn' : '');
  }
}

async function sendInThread(text) {
  const input = $('#sms-input');
  const body = text.trim();
  if (!body) return;
  if (body.length > state.sms.maxBody) return toast('Message is too long', true);

  const btn = $('#btn-sms-send');
  if (btn) busy(btn, true);

  // Optimistic bubble, replaced when the server confirms.
  const tempId = 'temp-' + Date.now();
  state.sms.messages.push({
    id: tempId, threadId: state.sms.activeId, direction: 'OUTBOUND',
    body: body, status: 'QUEUED', createdAt: new Date().toISOString(),
  });
  renderBubbles();
  scrollSmsToEnd();
  if (input) { input.value = ''; autosizeSms(); }

  try {
    const r = await api('/messages/threads/' + encodeURIComponent(state.sms.activeId) + '/send', {
      method: 'POST', body: { body: body },
    });
    // The live stream can deliver the stored message before this response
    // resolves, in which case the optimistic placeholder and the pushed copy
    // are both still in the array. Drop every trace and insert exactly one.
    state.sms.messages = state.sms.messages
      .filter((m) => m.id !== tempId && m.id !== r.message.id)
      .concat([r.message]);
    state.sms.messages.sort(byCreatedAt);
    renderBubbles();
    scrollSmsToEnd();
  } catch (e) {
    // Same de-duplication on the failure path.
    state.sms.messages = state.sms.messages.filter((m) => m.id !== tempId);
    state.sms.messages.push(Object.assign({}, {
      id: 'temp-failed-' + Date.now(),
      threadId: state.sms.activeId,
      direction: 'OUTBOUND',
      body: body,
      createdAt: new Date().toISOString(),
    }, { status: 'FAILED', error: friendly(e) }));
    state.sms.messages.sort(byCreatedAt);
    renderBubbles();
    toast(friendly(e), true);
  } finally {
    if (btn) busy(btn, false, 'Send');
  }
}

async function sendFirstMessage(to, body) {
  const btn = $('#btn-start-send');
  if (btn) busy(btn, true);
  try {
    const r = await api('/messages/send', { method: 'POST', body: { to: to, body: body } });
    const threadId = r.message.threadId;
    await openThread(threadId);
    await loadThreads();
    toast('Sent');
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    if (btn) busy(btn, false, 'Send');
  }
}

async function simulateReply() {
  if (!state.sms.activeId) return;
  const samples = [
    'Sounds good, thanks!',
    'Can you send that again?',
    'On my way.',
    'Got the message.',
    'Let me check and get back to you.',
    'Perfect, that works.',
  ];
  const text = samples[Math.floor(Math.random() * samples.length)];
  try {
    await api('/messages/threads/' + encodeURIComponent(state.sms.activeId) + '/simulate-inbound', {
      method: 'POST', body: { body: text },
    });
  } catch (e) {
    toast(friendly(e), true);
  }
}

async function threadAction(act) {
  const id = state.sms.activeId;
  if (!id) return;

  if (act === 'rename') {
    const current = state.sms.active.label || '';
    const next = prompt('Name this conversation', current);
    if (next === null) return;
    try {
      const r = await api('/messages/threads/' + encodeURIComponent(id), {
        method: 'PATCH', body: { label: next.trim() || null },
      });
      state.sms.active = r.thread;
      const t = state.sms.threads.find((x) => x.id === id);
      if (t) t.label = r.thread.label;
      renderSmsHeader();
      renderThreads();
    } catch (e) { toast(friendly(e), true); }
    return;
  }

  if (act === 'archive') {
    try {
      await api('/messages/threads/' + encodeURIComponent(id), { method: 'PATCH', body: { archived: true } });
      toast('Conversation archived');
      state.sms.activeId = null;
      state.sms.active = null;
      state.sms.messages = [];
      document.getElementById('sms-layout').classList.remove('picking');
      await loadThreads();
    } catch (e) { toast(friendly(e), true); }
    return;
  }

  if (act === 'delete-thread') {
    const ok = await confirmDialog('Delete this conversation?',
      'Every message in it is removed. This cannot be undone.', 'Delete');
    if (!ok) return;
    try {
      await api('/messages/threads/' + encodeURIComponent(id), { method: 'DELETE' });
      toast('Conversation deleted');
    } catch (e) { toast(friendly(e), true); }
  }
}

/* ============================================================
   tabs
   ============================================================ */
function setTab(tab, skipLoad) {
  state.tab = tab;
  store.set('pm.tab', tab);
  $$('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === tab));
  $('#tab-inbox').hidden = tab !== 'inbox';
  $('#tab-text').hidden = tab !== 'text';
  $('#tab-account').hidden = tab !== 'account';
  $('#tab-security').hidden = tab !== 'security';
  if (skipLoad) return;

  if (tab === 'inbox') {
    loadInbox(false);
  } else if (tab === 'text') {
    loadThreads();
  } else if (tab === 'account') {
    loadAccount(); loadPhones(); loadDevices(); loadPasskeys();
  } else {
    loadRecovery();
  }
}

/* ============================================================
   events
   ============================================================ */
$('#btn-theme').onclick = toggleTheme;

$('#btn-start').onclick = sendCode;
$('#in-phone').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });

$('#btn-verify').onclick = () => verifyCode();
$('#in-otp').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode(); });
$('#in-otp').addEventListener('input', (e) => { e.target.value = e.target.value.replace(/\D/g, ''); });

$('#btn-stepup').onclick = () => verifyCode($('#in-stepup').value.trim().toUpperCase());
$('#in-stepup').addEventListener('keydown', (e) => { if (e.key === 'Enter') verifyCode($('#in-stepup').value.trim().toUpperCase()); });
$('#btn-stepup-skip').onclick = () => {
  state.needsStepUp = false;
  $('#stepup').hidden = true;
  $('#in-otp').focus();
};

$('#btn-resend').onclick = () => { if (state.phone) { $('#in-phone').value = state.phone; sendCode(); } };
$('#btn-back1').onclick = () => { clearInterval(state.otpTimer); showStep(1); };
$('#btn-back2').onclick = () => showStep(2);

$('#btn-register').onclick = registerAccount;
$('#in-handle').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#in-name').focus(); });
$('#in-name').addEventListener('keydown', (e) => { if (e.key === 'Enter') registerAccount(); });

$('#btn-logout').onclick = () => signOut(true);
$('#tabs').addEventListener('click', (e) => {
  const t = e.target.closest('.tab');
  if (t) setTab(t.dataset.tab);
});
$$('[data-goto]').forEach((b) => { b.onclick = () => setTab(b.dataset.goto); });

$('#btn-dismiss-rc').onclick = () => { $('#rc-banner').hidden = true; store.set('pm.rcDismissed', true); };
$('#btn-copy-codes').onclick = async () => {
  const codes = $$('#rc-codes .code').map((c) => c.textContent);
  try {
    await navigator.clipboard.writeText(codes.join('\n'));
    toast('Copied ' + codes.length + ' codes');
  } catch (e) { toast('Clipboard blocked — select and copy them manually', true); }
};
$('#btn-banner-codes').onclick = () => { setTab('security'); generateNewCodes(); };

// Recovery codes are only ever shown once, so the banner must survive a
// reload until it is explicitly dismissed - otherwise a page refresh between
// copying and dismissing silently loses the only copy the user has.
function showRecoveryCodeBanner() {
  if (!state.recoveryCodes || !state.recoveryCodes.length) return;
  renderRecoveryCodes(state.recoveryCodes);
  $('#rc-banner').hidden = false;
  store.set('pm.rcDismissed', false);
}

/* ---- inbox ---- */
$('#btn-refresh').onclick = () => loadInbox(false);
$('#btn-test-msg').onclick = sendTestMessage;
$('#btn-load-more').onclick = () => loadInbox(true);

let searchTimer;
$('#f-search').addEventListener('input', (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.inbox.q = e.target.value.trim();
    loadInbox(false);
  }, 260);
});
$('#f-status').onchange = (e) => { state.inbox.status = e.target.value; loadInbox(false); };
$('#f-category').onchange = (e) => { state.inbox.category = e.target.value; loadInbox(false); };

$('#btn-select-all').onclick = () => {
  const all = state.inbox.messages.map((m) => m.id);
  const every = state.inbox.selected.length === all.length;
  state.inbox.selected = every ? [] : all;
  renderMessages();
  updateBulkBar();
};
$('#btn-bulk-read').onclick = () => bulkAction('read');
$('#btn-bulk-archive').onclick = () => bulkAction('archive');
$('#btn-bulk-delete').onclick = () => bulkAction('delete');
$('#btn-bulk-clear').onclick = () => { state.inbox.selected = []; renderMessages(); updateBulkBar(); };

$('#msg-list').addEventListener('click', async (e) => {
  const box = e.target.closest('[data-msg-select]');
  const card = e.target.closest('.msg');
  if (!card) return;
  const id = card.dataset.id;
  const msg = state.inbox.messages.find((m) => m.id === id);

  if (box) {
    const on = state.inbox.selected.indexOf(id) === -1;
    if (on) state.inbox.selected.push(id); else state.inbox.selected = state.inbox.selected.filter((x) => x !== id);
    box.checked = on;
    updateBulkBar();
    return;
  }

  const actBtn = e.target.closest('[data-msg-act]');
  if (actBtn) {
    e.stopPropagation();
    const act = actBtn.dataset.msgAct;
    if (act === 'delete') {
      const ok = await confirmDialog('Delete this message?', 'This cannot be undone.', 'Delete');
      if (!ok) return;
    }
    try {
      if (act === 'read') await api('/inbox/' + id + '/read', { method: 'PATCH', body: {} });
      if (act === 'archive') await api('/inbox/' + id + '/archive', { method: 'PATCH', body: {} });
      if (act === 'delete') await api('/inbox/' + id, { method: 'DELETE' });
      toast(act === 'delete' ? 'Deleted' : 'Updated');
      await loadInbox(false);
    } catch (err) { toast(friendly(err), true); }
    return;
  }

  card.classList.toggle('open');
  if (card.classList.contains('open') && msg && msg.status === 'UNREAD') {
    try {
      await api('/inbox/' + id + '/read', { method: 'PATCH', body: {} });
      msg.status = 'READ';
      state.inbox.selected = state.inbox.selected.filter((x) => x !== id);
      card.classList.remove('unread');
      card.classList.add('read');
      card.querySelector('.dot').classList.remove('unread');
      const btn = card.querySelector('[data-msg-act="read"]');
      if (btn) btn.remove();
      updateBulkBar();
      refreshUnread();
    } catch (err) { /* non-fatal */ }
  }
});

/* ---- text messages ---- */
$('#btn-new-thread').onclick = () => {
  state.sms.activeId = null;
  state.sms.active = null;
  state.sms.messages = [];
  document.getElementById('sms-layout').classList.add('picking');
  renderConversation();
  setTimeout(() => { const el = $('#in-start-to'); if (el) el.focus(); }, 60);
};

let threadSearch;
$('#f-thread').addEventListener('input', (e) => {
  clearTimeout(threadSearch);
  threadSearch = setTimeout(() => { state.sms.filter = e.target.value.trim(); renderThreads(); }, 200);
});

$('#sms-threads').addEventListener('click', (e) => {
  const item = e.target.closest('[data-thread]');
  if (item) openThread(item.dataset.thread);
});

// Delegated so re-rendering the whole view never loses a handler.
$('#sms-view').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]');
  if (!act) return;
  const a = act.dataset.act;
  if (a === 'simulate') return simulateReply();
  return threadAction(a);
});

$('#sms-view').addEventListener('submit', (e) => {
  const form = e.target;
  if (form.id === 'sms-form') {
    e.preventDefault();
    const input = $('#sms-input');
    if (input) sendInThread(input.value);
    return;
  }
  if (form.id === 'sms-start') {
    e.preventDefault();
    const to = $('#in-start-to').value.trim();
    const body = $('#in-start-body').value.trim();
    if (!to) return toast('Enter a phone number', true);
    if (!body) return toast('Write a message', true);
    sendFirstMessage(to, body);
  }
});

$('#sms-view').addEventListener('input', (e) => {
  if (e.target.id === 'sms-input') { autosizeSms(); return; }
  if (e.target.id === 'in-start-body') updateCounter(e.target.value.length);
});

$('#sms-view').addEventListener('keydown', (e) => {
  if (e.target.id !== 'sms-input') return;
  // Enter sends, Shift+Enter inserts a newline - the convention every chat
  // client uses, so it should not need explaining.
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendInThread(e.target.value);
  }
});

/* ---- account ---- */
$('#btn-add-phone').onclick = () => {
  // Drive visibility from the NEW state - using the previous value inverted
  // the panel, so clicking "Add number" opened it already closed.
  const next = !state.addPhone.open;
  state.addPhone = { open: next, bindingId: null, challengeId: null, devOtp: null };
  $('#add-phone').hidden = !next;
  $('#add-phone-otp').hidden = true;
  $('#btn-add-phone').textContent = next ? 'Cancel' : 'Add number';
  if (next) $('#in-newphone').focus();
};
$('#btn-add-phone-cancel').onclick = () => {
  if (state.addPhone.open) $('#btn-add-phone').click();
};
$('#btn-add-phone-go').onclick = async () => {
  const phone = $('#in-newphone').value.trim();
  if (!phone) return toast('Enter a phone number', true);
  const roleFlags = $$('.check input[data-role]').filter((c) => c.checked).map((c) => c.dataset.role);
  const btn = $('#btn-add-phone-go');
  busy(btn, true);
  try {
    const r = await api('/phones', { method: 'POST', body: { phone: phone, roleFlags: roleFlags.length ? roleFlags : ['LOGIN'] } });
    state.addPhone.bindingId = r.binding.id;
    state.addPhone.challengeId = r.challengeId;
    state.addPhone.devOtp = r.otp || null;
    $('#add-phone-otp').hidden = false;
    const note = $('#add-phone-otp');
    note.querySelector('label').textContent = 'Code sent to ' + phone +
      (r.otp ? ' — dev mode, code is ' + r.otp : ' (see server.log)');
    $('#in-newphone-otp').value = '';
    $('#in-newphone-otp').focus();
    toast('Code sent');
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Send code');
  }
};
$('#btn-add-phone-verify').onclick = async () => {
  const otp = $('#in-newphone-otp').value.trim();
  if (!/^\d{6}$/.test(otp)) return toast('Enter the 6-digit code', true);
  const btn = $('#btn-add-phone-verify');
  busy(btn, true);
  try {
    await api('/phones/' + state.addPhone.bindingId + '/verify', {
      method: 'POST', body: { challengeId: state.addPhone.challengeId, otp: otp },
    });
    $('#btn-add-phone').click();
    $('#in-newphone').value = '';
    toast('Phone number added');
    await Promise.all([loadPhones(), loadAccount()]);
  } catch (e) {
    toast(friendly(e), true);
  } finally {
    busy(btn, false, 'Verify & add');
  }
};

$('#phone-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-phone-act]');
  if (!btn) return;
  const item = e.target.closest('[data-phone]');
  const id = item.dataset.phone;

  if (btn.dataset.phoneAct === 'primary') {
    busy(btn, true);
    try {
      await api('/phones/' + id + '/primary', { method: 'PATCH', body: {} });
      toast('Primary number updated');
      await Promise.all([loadPhones(), loadAccount()]);
    } catch (err) { toast(friendly(err), true); busy(btn, false, 'Make primary'); }
    return;
  }

  if (btn.dataset.phoneAct === 'remove') {
    const ok = await confirmDialog('Remove this number?',
      'You will no longer be able to sign in with it. Security alerts will stop going there.', 'Remove');
    if (!ok) return;
    try {
      await api('/phones/' + id, { method: 'DELETE' });
      toast('Number removed');
      await Promise.all([loadPhones(), loadAccount()]);
    } catch (err) { toast(friendly(err), true); }
  }
});

$('#phone-list').addEventListener('change', async (e) => {
  const box = e.target.closest('[data-phone-role]');
  if (!box) return;
  const id = box.dataset.phoneRole;
  const roleFlags = $$('[data-phone-role="' + id + '"]').filter((c) => c.checked).map((c) => c.value);
  try {
    await api('/phones/' + id + '/roles', { method: 'PATCH', body: { roleFlags: roleFlags } });
    toast('Roles updated');
    loadPhones();
  } catch (err) {
    toast(friendly(err), true);
    loadPhones();
  }
});

/* ---- devices ---- */
$('#device-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-device-act]');
  if (!btn) return;
  const id = e.target.closest('[data-device]').dataset.device;

  if (btn.dataset.deviceAct === 'trust') {
    busy(btn, true);
    try {
      await api('/auth/device/trust', { method: 'POST', body: { deviceId: id, trustLevel: 'TRUSTED' } });
      toast('Device trusted');
      await Promise.all([loadDevices(), loadAccount()]);
    } catch (err) { toast(friendly(err), true); busy(btn, false, 'Trust'); }
    return;
  }

  const ok = await confirmDialog('Revoke this device?',
    'It is signed out immediately and can no longer be used to recover this account.', 'Revoke');
  if (!ok) return;
  try {
    await api('/auth/device/' + id, { method: 'DELETE' });
    toast('Device revoked');
    await Promise.all([loadDevices(), loadAccount()]);
  } catch (err) { toast(friendly(err), true); }
});

/* ---- passkeys ---- */
$('#passkey-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-passkey-act]');
  if (!btn) return;
  const id = e.target.closest('[data-passkey]').dataset.passkey;
  const ok = await confirmDialog('Revoke this passkey?',
    'You will no longer be able to sign in with it.', 'Revoke');
  if (!ok) return;
  try {
    await api('/passkeys/' + id, { method: 'DELETE' });
    toast('Passkey revoked');
    loadPasskeys();
  } catch (err) { toast(friendly(err), true); }
});

/* ---- security ---- */
$('#btn-new-codes').onclick = generateNewCodes;
$('#btn-verify-code').onclick = testRecoveryCode;
$('#in-verify-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') testRecoveryCode(); });
$('#btn-revoke-all').onclick = revokeAllSessions;
$('#btn-refresh-recovery').onclick = loadRecovery;
$('#btn-initiate-recovery').onclick = initiateRecovery;
$('#btn-add-contact').onclick = addContact;
$('#in-contact').addEventListener('keydown', (e) => { if (e.key === 'Enter') addContact(); });

/* ============================================================
   installable app (PWA)
   ============================================================ */
let deferredInstall = null;

window.addEventListener('beforeinstallprompt', (e) => {
  // Hold on to it so the Install button can fire it from a real user gesture -
  // without one, Chrome refuses to show the prompt.
  e.preventDefault();
  deferredInstall = e;
  $('#btn-install').hidden = false;
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  $('#btn-install').hidden = true;
  toast('PhoneMail installed');
});

$('#btn-install').onclick = async () => {
  if (!deferredInstall) return;
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) { /* dismissed */ }
  deferredInstall = null;
  $('#btn-install').hidden = true;
};

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => {
      console.warn('Service worker registration failed:', e && e.message);
    });
  });
}

/* ---- keyboard ---- */
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName);
  if (e.key === 'Escape' && typing) { document.activeElement.blur(); return; }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if ($('#view-app').hidden) return; // shortcuts are app-only

  if (e.key === '1') setTab('inbox');
  else if (e.key === '2') setTab('text');
  else if (e.key === '3') setTab('account');
  else if (e.key === '4') setTab('security');
  else if (e.key === '/') { e.preventDefault(); setTab('inbox'); setTimeout(() => $('#f-search').focus(), 60); }
  else if (e.key === 'r' || e.key === 'R') { if (state.tab === 'inbox') loadInbox(false); }
  else if (e.key === 't' || e.key === 'T') toggleTheme();
});

/* ============================================================
   boot
   ============================================================ */
(async function boot() {
  initTheme();

  if (state.recoveryCodes && !store.get('pm.rcDismissed', false)) showRecoveryCodeBanner();
  if (state.recoveryCodesRemaining === 0) renderFactorBanner(0);

  if (!state.token) { showView('auth'); showStep(1); return; }

  // Trust the stored token only after the server agrees it's still live.
  try {
    await loadAccount();
    showView('app');
    startSessionClock();
    scheduleRefresh();
    startPolling();
    connectEvents();
    loadThreads();
    // No skipLoad here: the first paint has to actually fetch the tab's data,
    // otherwise a reload lands on an empty inbox with a stale badge.
    setTab(state.tab);
    refreshUnread();
  } catch (e) {
    signOut(false);
  }
})();
