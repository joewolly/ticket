const CACHE = 'taskhub-capture-v3';
const ASSETS = [
  '/capture.html',
  '/app.js',
  '/planning.js',
  '/capture.js',
  '/draft-store.js',
  '/styles.css',
  '/manifest.webmanifest',
  '/icon.svg',
  '/apple-touch-icon.png',
];
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter(
              (key) => key.startsWith('taskhub-capture-') && key !== CACHE,
            )
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    url.origin !== self.location.origin ||
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/')
  )
    return;
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/capture.html')),
    );
  } else if (ASSETS.includes(url.pathname)) {
    event.respondWith(
      caches
        .match(url.pathname)
        .then((cached) => cached || fetch(event.request)),
    );
  }
});
