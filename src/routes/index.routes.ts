// src/routes/index.routes.ts
import { Router } from 'express';

const router = Router();

interface Endpoint {
  method: string;
  path: string;
  auth?: boolean;
}

interface Group {
  name: string;
  base: string;
  note: string;
  items: Endpoint[];
}

const GROUPS: Group[] = [
  {
    name: 'System',
    base: '/',
    note: 'No authentication required.',
    items: [
      { method: 'GET', path: '/health' },
      { method: 'GET', path: '/' },
    ],
  },
  {
    name: 'Authentication',
    base: '/auth',
    note: 'Start with POST /auth/phone/start to request an OTP.',
    items: [
      { method: 'POST', path: '/auth/phone/start' },
      { method: 'POST', path: '/auth/phone/verify' },
      { method: 'POST', path: '/auth/register/complete' },
      { method: 'POST', path: '/auth/refresh' },
      { method: 'POST', path: '/auth/logout', auth: true },
      { method: 'POST', path: '/auth/revoke-all', auth: true },
      { method: 'GET', path: '/auth/me', auth: true },
      { method: 'POST', path: '/auth/device/register', auth: true },
      { method: 'POST', path: '/auth/device/trust', auth: true },
      { method: 'DELETE', path: '/auth/device/:deviceId', auth: true },
      { method: 'POST', path: '/auth/recovery-codes', auth: true },
      { method: 'POST', path: '/auth/recovery-code/verify' },
    ],
  },
  {
    name: 'Phone numbers',
    base: '/phones',
    note: 'Bindings, roles and OTP fallback channels.',
    items: [
      { method: 'GET', path: '/phones', auth: true },
      { method: 'POST', path: '/phones', auth: true },
      { method: 'POST', path: '/phones/:id/verify', auth: true },
      { method: 'PATCH', path: '/phones/:id/primary', auth: true },
      { method: 'PATCH', path: '/phones/:id/roles', auth: true },
      { method: 'DELETE', path: '/phones/:id', auth: true },
      { method: 'POST', path: '/phones/change', auth: true },
      { method: 'POST', path: '/phones/otp/fallback', auth: true },
    ],
  },
  {
    name: 'Inbox',
    base: '/inbox',
    note: 'In-app message inbox, categories and acknowledgements.',
    items: [
      { method: 'GET', path: '/inbox', auth: true },
      { method: 'GET', path: '/inbox/unread-count', auth: true },
      { method: 'GET', path: '/inbox/:id', auth: true },
      { method: 'PATCH', path: '/inbox/:id/read', auth: true },
      { method: 'POST', path: '/inbox/:id/acknowledge', auth: true },
      { method: 'PATCH', path: '/inbox/:id/archive', auth: true },
      { method: 'DELETE', path: '/inbox/:id', auth: true },
      { method: 'POST', path: '/inbox/bulk', auth: true },
      { method: 'GET', path: '/inbox/summary/categories', auth: true },
      { method: 'POST', path: '/inbox/test', auth: true },
    ],
  },
  {
    name: 'Account recovery',
    base: '/recovery',
    note: 'Tiered recovery attempts, trusted contacts and recovery codes.',
    items: [
      { method: 'POST', path: '/recovery/initiate' },
      { method: 'GET', path: '/recovery/status' },
      { method: 'POST', path: '/recovery/:attemptId/approve' },
      { method: 'POST', path: '/recovery/:attemptId/cancel' },
      { method: 'POST', path: '/recovery/code/verify' },
      { method: 'GET', path: '/recovery/contacts' },
      { method: 'POST', path: '/recovery/contacts' },
      { method: 'POST', path: '/recovery/contacts/:contactId/confirm' },
      { method: 'DELETE', path: '/recovery/contacts/:contactId' },
    ],
  },
  {
    name: 'Passkeys',
    base: '/passkeys',
    note: 'WebAuthn registration and authentication.',
    items: [
      { method: 'GET', path: '/passkeys', auth: true },
      { method: 'POST', path: '/passkeys/register/start', auth: true },
      { method: 'POST', path: '/passkeys/register/complete', auth: true },
      { method: 'POST', path: '/passkeys/authenticate/start' },
      { method: 'POST', path: '/passkeys/authenticate/complete' },
      { method: 'DELETE', path: '/passkeys/:credentialId', auth: true },
    ],
  },
  {
    name: 'Webhooks',
    base: '/',
    note: 'Twilio / FCM callbacks. Reachable from the public internet.',
    items: [
      { method: 'POST', path: '/webhooks/sms/status' },
      { method: 'POST', path: '/webhooks/sms/inbound' },
      { method: 'POST', path: '/webhooks/voice/otp' },
      { method: 'POST', path: '/webhooks/voice/replay' },
      { method: 'POST', path: '/webhooks/voice/status' },
      { method: 'POST', path: '/webhooks/voice/inbound' },
      { method: 'POST', path: '/webhooks/voice/inbound-menu' },
      { method: 'POST', path: '/webhooks/email/inbound' },
      { method: 'POST', path: '/webhooks/push/token' },
      { method: 'GET', path: '/webhooks/health' },
    ],
  },
];

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PhoneMail API</title>
<style>
  :root {
    --bg: #0d1117; --panel: #161b22; --border: #30363d;
    --text: #e6edf3; --muted: #8b949e; --accent: #58a6ff;
    --get: #58a6ff; --post: #3fb950; --patch: #d29922; --delete: #f85149;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .wrap { max-width: 940px; margin: 0 auto; padding: 40px 24px 80px; }
  header { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; margin-bottom: 6px; }
  h1 { font-size: 28px; margin: 0; letter-spacing: -0.02em; }
  .tag { color: var(--muted); font-size: 14px; }
  .status {
    margin-left: auto; display: inline-flex; align-items: center; gap: 8px;
    padding: 5px 12px; border: 1px solid var(--border); border-radius: 999px;
    font-size: 13px; color: var(--muted); background: var(--panel);
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #6e7681; }
  .dot.up { background: var(--post); box-shadow: 0 0 0 3px rgba(63,185,80,.18); }
  .dot.down { background: var(--delete); box-shadow: 0 0 0 3px rgba(248,81,73,.18); }
  .lead { color: var(--muted); margin: 0 0 32px; max-width: 68ch; }
  .card {
    background: var(--panel); border: 1px solid var(--border);
    border-radius: 10px; margin-bottom: 18px; overflow: hidden;
  }
  .card > h2 {
    font-size: 13px; text-transform: uppercase; letter-spacing: .08em;
    color: var(--muted); margin: 0; padding: 13px 18px;
    border-bottom: 1px solid var(--border); background: rgba(255,255,255,.02);
    display: flex; gap: 10px; align-items: baseline;
  }
  .card > h2 .base { color: var(--accent); font-weight: 600; text-transform: none; letter-spacing: 0; }
  .card > h2 .note { margin-left: auto; font-weight: 400; text-transform: none; letter-spacing: 0; font-size: 12px; }
  ul { list-style: none; margin: 0; padding: 0; }
  li {
    display: flex; align-items: center; gap: 12px;
    padding: 9px 18px; border-bottom: 1px solid rgba(48,54,61,.55);
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 13.5px;
  }
  li:last-child { border-bottom: 0; }
  li:hover { background: rgba(88,166,255,.05); }
  .m {
    flex: 0 0 62px; text-align: center; font-weight: 700; font-size: 11px;
    padding: 3px 0; border-radius: 5px; letter-spacing: .04em;
    background: rgba(139,148,158,.14); color: var(--muted);
  }
  .m.GET { background: rgba(88,166,255,.15); color: var(--get); }
  .m.POST { background: rgba(63,185,80,.15); color: var(--post); }
  .m.PATCH { background: rgba(210,153,34,.15); color: var(--patch); }
  .m.DELETE { background: rgba(248,81,73,.15); color: var(--delete); }
  .p { flex: 1; color: var(--text); word-break: break-all; }
  .auth { flex: 0 0 auto; font-size: 11px; color: var(--muted); }
  .auth::before { content: "\\1f512 "; }
  pre {
    background: var(--panel); border: 1px solid var(--border); border-radius: 10px;
    padding: 16px 18px; overflow-x: auto; font-size: 13px; line-height: 1.7;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  pre .c { color: var(--muted); }
  pre .k { color: var(--get); }
  h3 { font-size: 15px; margin: 34px 0 12px; }
  footer { margin-top: 40px; color: var(--muted); font-size: 13px; border-top: 1px solid var(--border); padding-top: 18px; }
  code { background: rgba(110,118,129,.2); padding: 1px 6px; border-radius: 4px; font-size: .92em; }
  @media (max-width: 620px) { .card > h2 .note { display: none; } .auth { display: none; } }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>PhoneMail</h1>
    <span class="tag">REST API</span>
    <span class="status"><span class="dot" id="dot"></span><span id="stxt">checking&hellip;</span></span>
  </header>
  <p class="lead">
    PhoneMail's JSON API. A browser UI is served at
    <a href="/" style="color:var(--accent)">localhost:3000/</a> &mdash; this page documents the
    endpoints behind it. Use these paths from your client, or a tool like <code>curl</code>.
  </p>

  <div id="groups"></div>

  <h3>Quick start</h3>
  <pre><span class="c"># 1. Request an OTP  (dev mode prints it to the server console)</span>
curl -X POST http://localhost:3000/auth/phone/start \\
  -H <span class="k">"Content-Type: application/json"</span> \\
  -d <span class="k">'{"phone":"+14155550100","channel":"SMS"}'</span>

<span class="c"># 2. Verify it  ->  { verified: true, needsRegistration: true }</span>
curl -X POST http://localhost:3000/auth/phone/verify \\
  -H <span class="k">"Content-Type: application/json"</span> \\
  -d <span class="k">'{"challengeId":"...","otp":"123456"}'</span>

<span class="c"># 3. Register  ->  201 { account, tokens, recoveryCodes }</span>
curl -X POST http://localhost:3000/auth/register/complete \\
  -H <span class="k">"Content-Type: application/json"</span> \\
  -d <span class="k">'{"challengeId":"...","otp":"123456","handle":"alice","displayName":"Alice"}'</span>

<span class="c"># 4. Use the access token</span>
curl http://localhost:3000/auth/me -H <span class="k">"Authorization: Bearer &lt;accessToken&gt;"</span></pre>

  <footer>
    Endpoints marked <span class="auth" style="display:inline">auth</span> require
    <code>Authorization: Bearer &lt;accessToken&gt;</code>.
    Dev mode (<code>FORCE_DEV_MODE=true</code>) simulates SMS and voice delivery, so OTPs are
    printed to the server console instead of being sent.
  </footer>
</div>
<script>
  var DATA = __DATA__;
  var el = document.getElementById('groups');
  el.innerHTML = DATA.filter(function (g) { return g.name !== 'System'; }).map(function (g) {
    return '<section class="card"><h2>' + g.name +
      ' <span class="base">' + g.base + '</span>' +
      '<span class="note">' + g.note + '</span></h2><ul>' +
      g.items.map(function (i) {
        return '<li><span class="m ' + i.method + '">' + i.method + '</span>' +
          '<span class="p">' + i.path + '</span>' +
          (i.auth ? '<span class="auth"></span>' : '') + '</li>';
      }).join('') + '</ul></section>';
  }).join('');

  fetch('/health').then(function (r) { return r.json(); }).then(function () {
    document.getElementById('dot').className = 'dot up';
    document.getElementById('stxt').textContent = 'online';
  }).catch(function () {
    document.getElementById('dot').className = 'dot down';
    document.getElementById('stxt').textContent = 'offline';
  });
</script>
</body>
</html>`;

router.get('/api', (req, res) => {
  res.type('html').send(PAGE.replace('__DATA__', JSON.stringify(GROUPS)));
});

export default router;
