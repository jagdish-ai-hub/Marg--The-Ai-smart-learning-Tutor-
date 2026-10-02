/**
 * A minimal service worker: just enough to make the app installable and to
 * keep the app shell (HTML/CSS/JS/icons) available when the network is slow
 * or briefly unavailable.
 *
 * What it deliberately does NOT do:
 *   - Cache anything cross-origin. The backend API (a different origin in
 *     dev, and likely in production too) is never touched here.
 *   - Cache anything that isn't a plain GET. Every API call this app makes
 *     is either a POST/PATCH/DELETE or an EventSource (SSE) stream, and
 *     intercepting an SSE connection in a service worker fetch handler can
 *     break streaming outright. The fetch handler below only ever looks at
 *     same-origin GET requests for the app's own static files — everything
 *     else passes straight through untouched, exactly as if this file did
 *     not exist.
 */

const CACHE_VERSION = 'marg-shell-v1';

/** The app shell: enough to render every screen, fetched once on install. */
const SHELL_FILES = [
  './',
  'index.html',
  'app.html',
  'session.html',
  'insights.html',
  'css/tokens.css',
  'css/base.css',
  'css/landing.css',
  'css/app.css',
  'js/marg-client.js',
  'js/config.js',
  'js/icons.js',
  'js/shell.js',
  'js/subjects-ui.js',
  'js/format.js',
  'js/landing.js',
  'js/app.js',
  'js/session.js',
  'js/insights.js',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(SHELL_FILES))
      // Activate this version immediately rather than waiting for every open
      // tab to close — the shell files are static and safe to swap in right away.
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only ever handle same-origin GETs for this app's own files. Anything
  // else — the API, SSE streams, any cross-origin request — is left
  // completely alone.
  if (request.method !== 'GET') return;
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          // Only cache successful, basic (same-origin, non-opaque) responses.
          if (response.ok && response.type === 'basic') {
            const copy = response.clone();
            caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached);

      // Cache-first for instant loads; the network request above still runs
      // in the background and refreshes the cache for next time.
      return cached || network;
    }),
  );
});
