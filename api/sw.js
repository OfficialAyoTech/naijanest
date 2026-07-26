const CACHE_NAME = 'naijanest-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/auth.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // don't block install if one asset fails to pre-cache
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept API calls or cross-origin requests (Supabase, Paystack, Groq proxy, CDNs) —
  // property data, auth, and payments must always hit the network live.
  if (url.pathname.startsWith('/api/') || url.origin !== self.location.origin) {
    return;
  }

  // Page navigations: network-first, so signed-in users and fresh listings always show up
  // when online; fall back to the last cached shell only if the network is unreachable.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((resp) => {
          const copy = resp.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return resp;
        })
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // Static assets (icons, manifest, auth.js): cache-first for speed
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
