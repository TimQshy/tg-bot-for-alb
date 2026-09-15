// Minimal service worker — exists only to satisfy PWA installability
// criteria. No offline cache: this dashboard always needs live data.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', event => event.respondWith(fetch(event.request)));
