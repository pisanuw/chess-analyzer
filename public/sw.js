// Service worker: the app shell plus the last drill deck stay usable with no
// signal (a tournament hall), which is exactly where a pre-game drill set is
// wanted. Network first everywhere, so online behaviour is unchanged and a new
// version of the app is picked up on the next load; the cache is only the
// fallback. Only the drill deck and the three small startup calls are cached
// from the API; every other API response is never stored. Reviews made offline
// are queued in localStorage by api.js and replayed in order on reconnect.
const CACHE = 'chess-analyzer-v1';
const OFFLINE_API = new Set(['/api/drills', '/api/auth/me', '/api/status', '/api/settings']);

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') && !OFFLINE_API.has(url.pathname)) return;
  e.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    if (req.mode === 'navigate') {
      const shell = await cache.match('/');
      if (shell) return shell;
    }
    throw err;
  }
}
