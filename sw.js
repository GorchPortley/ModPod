// sw.js — offline cache so the deck works in a club with no Wi-Fi.
// Bump VERSION whenever you change any app file so tablets pick up the update.
const VERSION = 'modpod-v1';
const FILES = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/deck.js', 'js/views.js', 'js/deck-processor.js',
  'js/mod/modfile.js', 'js/mod/modplayer.js', 'js/audio/bufferplayer.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/icon-512.png',
  'demo/modpod-demo.mod',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates show up when online), cache as fallback.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true })),
  );
});
