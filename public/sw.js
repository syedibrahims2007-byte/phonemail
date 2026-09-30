// PhoneMail service worker - app shell only.
//
// Two rules this file exists to enforce:
//
// 1. Never cache anything authenticated. A cached response can be replayed to a
//    different account because the browser cache key ignores the Authorization
//    header, so the safe design is a strict allowlist of static assets rather
//    than enumerating API routes and hoping the list stays complete. Anything
//    not in SHELL is left entirely alone and goes to the network.
//
// 2. Network-first, not cache-first. Cache-first was tried first and served a
//    stale app.js indefinitely: a redeploy never reached an already-visited
//    client. Going to the network first keeps updates immediate, and the cache
//    is still there for when there is no network.
const CACHE = 'phonemail-shell-v2';

const SHELL = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/icon-maskable.svg',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // addAll is atomic: one 404 would leave the app with no offline shell at
      // all, so failures are tolerated per-asset instead.
      .then((cache) => Promise.all(
        [...SHELL].map((url) =>
          cache.add(url).catch((e) => console.warn('[sw] could not cache', url, e))
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;
  if (!SHELL.has(url.pathname)) return;
  if (request.headers.has('authorization')) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
        }
        return res;
      })
      .catch(() =>
        // Offline: the cached shell keeps the app launchable.
        caches.open(CACHE)
          .then((cache) => cache.match(request))
          .then((hit) => hit || cache.match('/index.html'))
      )
  );
});
