/**
 * chart-fin service worker.
 *
 * Goals:
 *   • Make the installed PWA boot offline / instantly from the home screen.
 *   • NEVER touch `/data/` — those CSVs run to hundreds of MB and caching them
 *     would blow the origin quota and compete with the IndexedDB candle store,
 *     which is the actual source of truth for market data.
 *
 * Strategy:
 *   navigation      → network-first, fall back to the cached shell when offline
 *   /assets/<hash>  → cache-first (Vite content-hashes these, so they're immutable)
 *   everything else → stale-while-revalidate
 */
const VERSION = 'v1';
const SHELL_CACHE = `chart-fin-shell-${VERSION}`;
const RUNTIME_CACHE = `chart-fin-runtime-${VERSION}`;
const SHELL_URL = '/index.html';

const PRECACHE = [SHELL_URL, '/manifest.webmanifest', '/favicon.svg'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then(cache => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(
          keys
            .filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map(k => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

/** Market data and the manifest must always come from the network. */
function isExcluded(url) {
  return url.pathname.startsWith('/data/');
}

self.addEventListener('fetch', event => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (isExcluded(url)) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(SHELL_URL, copy));
          return res;
        })
        .catch(() => caches.match(SHELL_URL)),
    );
    return;
  }

  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(
      caches.match(request).then(
        hit =>
          hit ||
          fetch(request).then(res => {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(request, copy));
            return res;
          }),
      ),
    );
    return;
  }

  event.respondWith(
    caches.match(request).then(hit => {
      const network = fetch(request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
