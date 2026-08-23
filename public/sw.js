// Bump CACHE_VERSION whenever any precached asset changes.
const CACHE_VERSION = 'v2';
const CACHE = `web-zotero-static-${CACHE_VERSION}`;
const ASSETS = [
  '/', '/styles.css', '/app.js', '/manifest.webmanifest',
  '/annotator', '/annotator.js', '/annotator.css',
  '/notes', '/notes.js', '/notes.css',
  '/vendor/pdf.worker.min.mjs'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => Promise.allSettled(ASSETS.map(asset => cache.add(asset))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    const copy = response.clone();
    const cache = await caches.open(CACHE);
    cache.put(request, copy);
  }
  return response;
}

async function navigationStrategy(request) {
  // Network-first so UI updates land; cache (and finally the shell) when offline.
  try {
    const response = await fetch(request);
    if (response.ok) {
      const copy = response.clone();
      const cache = await caches.open(CACHE);
      cache.put(request, copy);
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    return cached || caches.match('/');
  }
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  if (request.mode === 'navigate') {
    event.respondWith(navigationStrategy(request));
    return;
  }
  event.respondWith(cacheFirst(request).catch(() => caches.match('/')));
});
