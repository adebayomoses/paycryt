// Service worker for the POS: lets the till reload and open with no connection at all.
//
// It caches ONLY the app's own static files under /ui/. It never touches API calls (/v1/...), so a sale can never be
// answered from a cache, and nothing about a payment or a key is ever stored here. Network first, so an updated app
// is picked up the next time the till is online; the cache is only the fallback.

const CACHE = 'paycryt-pos-v1';
const SHELL = ['/ui/pos.html', '/ui/pos.js', '/ui/pos.css', '/ui/style.css', '/ui/manifest.webmanifest', '/ui/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  // Anything that is not one of our own static files is left entirely alone (API calls, other origins, non-GET).
  if (req.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/ui/')) return;

  event.respondWith(
    (async () => {
      try {
        // A short timeout, so a dead-but-not-refused connection falls back to the cache quickly instead of hanging.
        const res = await fetch(req, { signal: AbortSignal.timeout(4000) });
        if (res.ok) (await caches.open(CACHE)).put(req, res.clone());
        return res;
      } catch (err) {
        const hit = await caches.match(req, { ignoreSearch: true });
        if (hit) return hit;
        throw err;
      }
    })(),
  );
});
