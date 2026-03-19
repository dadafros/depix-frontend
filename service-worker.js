const CACHE_NAME = "depix-static-v6";

const STATIC_FILES = [
  "./index.html",
  "./style.css",
  "./script.js",
  "./script-helpers.js",
  "./utils.js",
  "./validation.js",
  "./router.js",
  "./auth.js",
  "./api.js",
  "./addresses.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

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

self.addEventListener("fetch", event => {
  const req = event.request;

  // Never interfere with POST or API calls
  if (req.method !== "GET") return;

  if (
    req.url.startsWith("https://depix-backend.vercel.app") ||
    req.url.startsWith("https://api.qrserver.com") ||
    req.url.includes("/api/")
  ) {
    return;
  }

  // Cache-first for static files only
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req);
    })
  );
});
