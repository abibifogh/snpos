/* eslint-disable no-undef */
/**
 * The service worker, so the app opens with no connection at all.
 *
 * Copied into each app's build output by the deploy, because a service worker
 * can only control pages inside its own folder — one at the site root could not
 * be registered by /admin/ with the scope it needs.
 *
 * Two strategies, chosen for what each thing actually is:
 *
 *   - The page itself: network first. A deploy must reach people, and an app
 *     shell served from cache for ever is how a fixed bug stays broken.
 *   - Everything else with a content hash in its name: cache first. Those files
 *     never change — that is what the hash means — so going to the network for
 *     them is pure latency, and having them cached is what makes the app open
 *     on a dead connection.
 *
 * Appwrite requests are deliberately never cached. Stale orders on a kitchen
 * screen are worse than no orders: one is obviously broken, the other is
 * quietly wrong. Offline reads come from the snapshots in offline.ts, which are
 * explicit about their age.
 */

const VERSION = 'snpos-v1';
const SHELL = `${VERSION}-shell`;

self.addEventListener('install', (event) => {
  // Take over as soon as the new worker is ready rather than waiting for every
  // tab to close — a kitchen screen is never closed.
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((n) => !n.startsWith(VERSION)).map((n) => caches.delete(n)));
      await self.clients.claim();
    })(),
  );
});

const isAsset = (url) => /\/assets\/[^/]+\.[0-9a-zA-Z_-]+\.(js|css|woff2?|png|svg|jpg|webp)$/.test(url.pathname)
  || /\/assets\//.test(url.pathname);

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Anything not on this origin is somebody else's business — chiefly Appwrite,
  // which must never be served from a cache.
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      (async () => {
        try {
          const fresh = await fetch(request);
          const cache = await caches.open(SHELL);
          cache.put(request, fresh.clone());
          return fresh;
        } catch {
          const cached = await caches.match(request);
          if (cached) return cached;
          // A deep link that was never visited online still has to open, and
          // the app routes on the hash anyway.
          const index = await caches.match(new URL('./index.html', self.registration.scope).href);
          if (index) return index;
          return new Response(
            '<h1>Offline</h1><p>This page has not been opened on this device before, so there is nothing saved to show. Reconnect once and it will work offline afterwards.</p>',
            { headers: { 'Content-Type': 'text/html' }, status: 503 },
          );
        }
      })(),
    );
    return;
  }

  if (isAsset(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        const fresh = await fetch(request);
        const cache = await caches.open(SHELL);
        cache.put(request, fresh.clone());
        return fresh;
      })(),
    );
  }
});
