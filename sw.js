// Hedonist – service worker (cache-first).
// Pri KAŽDEJ zmene súborov zvýš CACHE_VERSION a nové súbory pridaj do ASSETS.

const CACHE_VERSION = 'v7';

// Doména github.io je spoločná pre všetky projekty, preto vlastný prefix.
const CACHE_PREFIX = 'hedonist-';
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const ASSETS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './db.js',
  './export.js',
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

/* ---------- Pripomienka po 20 minútach (best effort) ---------- */

// Prehliadač môže nečinný service worker kedykoľvek ukončiť a časovač zanikne.
const reminders = new Map(); // id → { timer, resolve }

function cancelReminder(id) {
  const reminder = reminders.get(id);
  if (!reminder) return;
  clearTimeout(reminder.timer);
  reminders.delete(id);
  reminder.resolve();
}

function scheduleReminder({ id, at, title, options }) {
  cancelReminder(id);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      reminders.delete(id);
      resolve(self.registration.showNotification(title, options));
    }, Math.max(0, at - Date.now()));
    reminders.set(id, { timer, resolve });
  });
}

self.addEventListener('message', (event) => {
  const { type, id } = event.data ?? {};
  if (type === 'SKIP_WAITING') self.skipWaiting();
  if (type === 'GET_VERSION') event.ports[0].postMessage(CACHE_VERSION);
  if (type === 'REMIND') event.waitUntil(scheduleReminder(event.data));
  if (type === 'CANCEL') cancelReminder(id);
  if (type === 'CANCEL_ALL') [...reminders.keys()].forEach(cancelReminder);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const id = event.notification.data?.id;
  if (!id) return;

  event.waitUntil((async () => {
    const { scope } = self.registration;
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = windows.find(({ url }) => {
      const address = url.split(/[?#]/)[0];
      return address === scope || address === `${scope}index.html`;
    });
    if (app) {
      app.postMessage({ type: 'OPEN', id });
      await app.focus();
    } else {
      await self.clients.openWindow(`${scope}#doplnit-${id}`);
    }
  })());
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
