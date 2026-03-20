const CACHE_NAME = "depix-v13";

const STATIC_FILES = [
  "./",
  "./index.html",
  "./style.css",
  "./script.js",
  "./router.js",
  "./auth.js",
  "./api.js",
  "./addresses.js",
  "./utils.js",
  "./validation.js",
  "./script-helpers.js",
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

  // Stale-while-revalidate: serve cache immediately, update in background
  event.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(req).then(cached => {
        const fetched = fetch(req).then(response => {
          if (response.ok) cache.put(req, response.clone());
          return response;
        });
        return cached || fetched;
      })
    )
  );
});
