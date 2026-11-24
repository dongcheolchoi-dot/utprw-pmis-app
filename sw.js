/* U-Tapao PMIS Mobile Service Worker — Offline-First App Shell */
const CACHE_NAME = 'pmis-mobile-shell-v0.9.3-7';
const APP_SHELL_FILES = [
  './',
  './index.html',
  './manifest.json',
  './css/mobile.css',
  './js/config.js',
  './js/version.js',
  './js/i18n.js',
  './js/db.js',
  './js/api.js',
  './js/rit.js',
  './js/fieldmap.js',
  './js/obs.js',
  './js/dailydetail.js',
  './js/notify.js',
  './js/updater.js',
  './js/app.js',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/leaflet.css',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Only cache same-origin static assets; let GAS/external requests hit network
  if (url.origin !== self.location.origin) return;

  // Network-first for HTML/JS/CSS when online so OTA updates apply seamlessly,
  // falling back immediately to cache when offline (airplane mode).
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return res;
      })
      .catch(() => caches.match(req).then((cached) => cached || caches.match('./index.html')))
  );
});

// 🔔 앱 자체 알림 클릭 → 열려 있는 앱 창으로 이동해 해당 탭 열기 (없으면 새로 열기, 2026-11-20)
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const tab = (event.notification.data && event.notification.data.tab) || 'tasks';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          c.postMessage({ type: 'PMIS_OPEN_TAB', tab: tab });
          return c.focus();
        }
      }
      return self.clients.openWindow('./index.html#tab=' + tab);
    })
  );
});