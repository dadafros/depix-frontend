// Service Worker — DePix PWA
// Bump APP_VERSION on every release. Keep in sync with ?v= query strings in index.html.
const APP_VERSION = 100;
const CACHE_NAME = `depix-v${APP_VERSION}`;

const STATIC_FILES = [
  "./",
  "./index.html",
  `./style.css?v=${APP_VERSION}`,
  `./script.js?v=${APP_VERSION}`,
  `./router.js?v=${APP_VERSION}`,
  `./auth.js?v=${APP_VERSION}`,
  `./api.js?v=${APP_VERSION}`,
  `./addresses.js?v=${APP_VERSION}`,
  `./utils.js?v=${APP_VERSION}`,
  `./validation.js?v=${APP_VERSION}`,
  `./script-helpers.js?v=${APP_VERSION}`,
  `./affiliates.js?v=${APP_VERSION}`,
  `./qr.js?v=${APP_VERSION}`,
  `./manifest.json?v=${APP_VERSION}`,
  `./icon-192.png?v=${APP_VERSION}`,
  `./icon-512.png?v=${APP_VERSION}`
];

// Install — cache all static assets and activate immediately
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.all(
        STATIC_FILES.map(url =>
          fetch(url, { cache: "reload" }).then(res => cache.put(url, res))
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate — delete old caches and take control of all clients
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key => key !== CACHE_NAME && caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Fetch — strategy depends on request type
self.addEventListener("fetch", event => {
  const req = event.request;
  const url = new URL(req.url);

  // Never interfere with non-GET requests
  if (req.method !== "GET") return;

  // Never cache API calls or external resources
  if (
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) {
    return;
  }

  // Navigation (HTML) — network-first with cache fallback
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Static assets — cache-first with network fallback
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});
