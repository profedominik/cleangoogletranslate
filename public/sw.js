// CleanTranslate service worker: network-first app shell, so the editor still
// opens offline (notes are kept in localStorage until the server is reachable).
// API calls are never cached here.
const CACHE = 'ct-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin || url.pathname.includes('/api/') || url.pathname.includes('/admin')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && (res.type === 'basic' || res.type === 'default')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req, copy));
      }
      return res;
    } catch (err) {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(req.mode === 'navigate' ? new URL('./', self.registration.scope).href : req, { ignoreSearch: true });
      if (hit) return hit;
      throw err;
    }
  })());
});
