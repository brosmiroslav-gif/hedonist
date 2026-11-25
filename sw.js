// Hedonist – service worker (cache-first).
// Pri KAŽDEJ zmene súborov zvýš CACHE_VERSION a nové súbory pridaj do ASSETS.

const CACHE_VERSION = 'v3';

// Doména github.io je spoločná pre všetky projekty, preto vlastný prefix.
const CACHE_PREFIX = 'hedonist-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './manifest.webmanifest',
  './fonts/IBMPlexSansCondensed-Regular.woff2',
  './fonts/IBMPlexSansCondensed-SemiBold.woff2',
  './fonts/IBMPlexSansCondensed-Bold.woff2',
  './fonts/IBMPlexMono-Medium.woff2',
  './fonts/IBMPlexMono-SemiBold.woff2',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    // 'reload' obíde HTTP cache, aby sa do novej verzie nedostali staré kópie.
    await cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' })));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (event.data?.type === 'GET_VERSION') event.ports[0].postMessage(CACHE_VERSION);
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const isNavigation = request.mode === 'navigate';
    const cached = await cache.match(request, { ignoreSearch: isNavigation });
    if (cached) return cached;

    try {
      return await fetch(request);
    } catch (error) {
      if (isNavigation) return cache.match('./index.html');
      throw error;
    }
  })());
});
