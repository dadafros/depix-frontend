const CACHE_NAME = "depix-static-v3";

// ⚠️ SOMENTE arquivos estáticos seguros
const STATIC_FILES = [
  "./index.html",
  "./style.css",
  "./script.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_FILES))
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

  // ❌ Nunca interferir com POST (pagamento)
  if (req.method !== "GET") return;

  // ❌ Nunca cachear chamadas externas / API
  if (
    req.url.startsWith("https://depix-backend.vercel.app") ||
    req.url.startsWith("https://api.qrserver.com") ||
    req.url.includes("/api/")
  ) {
    return;
  }

  // ✅ Cache-first apenas para arquivos estáticos
  event.respondWith(
    caches.match(req).then(cached => {
      if (cached) return cached;
      return fetch(req);
    })
  );
});
