// Service Worker — DePix PWA
// Bump APP_VERSION on every release. Keep in sync with ?v= query strings in index.html.
const APP_VERSION = 132;
const CACHE_NAME = `depix-v${APP_VERSION}`;

// Timeout for WASM fetch before falling back to cache. WASM binaries are large
// (~5 MB for lwk_wasm). Cellular networks can stall; we refuse to spin forever.
const WASM_FETCH_TIMEOUT_MS = 10000;

// ES module imports in script.js use unversioned specifiers (./utils.js),
// so the browser requests unversioned URLs. We must pre-cache BOTH the
// versioned URLs (referenced by index.html) AND the unversioned module
// URLs — otherwise a previously-cached stale unversioned file can be
// served to a new script.js, causing SyntaxError on missing exports.
const JS_MODULES = [
  "router.js",
  "auth.js",
  "api.js",
  "addresses.js",
  "utils.js",
  "validation.js",
  "script-helpers.js",
  "affiliates.js",
  "qr.js",
  "qr-print.js",
  "image-resize.js",
  "wallet-bundle-loader.js"
];

// Brand logos for the wallet asset rows. DePix reuses icon-192.png above
// (the app icon IS the DePix brand). The liquid-tether SVG + liquid-bitcoin
// PNG are vendored from the official Blockstream / BTCPay artwork so the
// wallet home shows the same logos users recognise from other Liquid apps.
// Referenced from wallet/asset-registry.js with origin-absolute paths.
const ICON_FILES = [
  "icons/depix.png",
  "icons/liquid-tether.svg",
  "icons/liquid-bitcoin.png"
];

const STATIC_FILES = [
  "./",
  "./index.html",
  `./style.css?v=${APP_VERSION}`,
  `./script.js?v=${APP_VERSION}`,
  `./manifest.json?v=${APP_VERSION}`,
  `./icon-192.png?v=${APP_VERSION}`,
  `./icon-512.png?v=${APP_VERSION}`,
  ...JS_MODULES.map(f => `./${f}?v=${APP_VERSION}`),
  ...JS_MODULES.map(f => `./${f}`),
  ...ICON_FILES.map(f => `./${f}`)
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

function fetchWithTimeout(req, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return fetch(req, { signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

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

  // Wallet manifest — network-first. The manifest points the loader at the
  // current content-hashed bundle filename; a stale cached manifest would
  // reference a filename that no longer exists on the server after a wallet-
  // only deploy (hash rotated, APP_VERSION unchanged). Keep it fresh.
  // Falls back to cache when offline so a reload without network can still
  // read whatever bundle was last installed.
  if (url.pathname === "/dist/manifest.json") {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Wallet bundle + WASM — cache-first (content-hashed filename, so a new
  // build always produces a new URL). Timeout on the network fallback so a
  // stalled cellular fetch does not block wallet init forever.
  //
  // On cold install + timeout the fetch rejects with AbortError; we catch it
  // and synthesize a 504 Response so the Sub-fase 2 loader can branch on
  // response.ok / response.status instead of unwrapping a raw reject. UX copy
  // ("Carregando carteira…" etc.) is rendered by the loader in Sub-fase 2+.
  if (url.pathname.startsWith("/dist/") && /\.(wasm|js)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetchWithTimeout(req, WASM_FETCH_TIMEOUT_MS)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
            }
            return response;
          })
          .catch(err => {
            const aborted = err && err.name === "AbortError";
            return new Response("", {
              status: 504,
              statusText: aborted ? "Wallet fetch timeout" : "Wallet fetch failed"
            });
          });
      })
    );
    return;
  }

  // JS/CSS — network-first so a stale cached module never shadows a fresh
  // script.js that imports new bindings. Falls back to cache when offline.
  if (/\.(js|css)$/.test(url.pathname)) {
    event.respondWith(
      fetch(req)
        .then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(req, clone));
          }
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Other static assets (images, icons) — cache-first with network fallback
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
