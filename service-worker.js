// Service Worker — DePix PWA
// Bump APP_VERSION on every release. Keep in sync with ?v= query strings in index.html.
const APP_VERSION = 146;

// Two caches, two lifecycles:
//   LEGACY_CACHE — bumps with APP_VERSION. Holds HTML, script.js, style.css,
//                  legacy JS modules, manifest.json, icons. Deleted and
//                  rebuilt on every release.
//   WALLET_CACHE — never bumps. Holds /dist/* (wallet bundle, LWK WASM,
//                  dist/manifest.json). Filenames are content-hashed by
//                  esbuild, so a new build naturally produces new keys; the
//                  GC routine prunes stale hashed entries when the manifest
//                  rotates. This survives APP_VERSION bumps so a 5px CSS
//                  tweak no longer evicts the 5 MB LWK WASM blob.
const LEGACY_CACHE = `depix-legacy-v${APP_VERSION}`;
const WALLET_CACHE = "depix-wallet";

// Matches both the pre-split combined caches (`depix-v144`, `depix-v145`) AND
// the new `depix-legacy-vN` form. Activate uses this to scope eviction to
// legacy caches only — `depix-wallet` is preserved.
const LEGACY_CACHE_RX = /^depix-(legacy-)?v\d+$/;

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
  "qr-scanner.js",
  "jsqr.js",
  "wallet-bundle-loader.js",
  "wallet-home-gate.js",
  "wallet-integrated-gate.js",
  "wallet/config.js",
  "wallet/telemetry.js",
  "wallet/withdraw-archive.js"
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

// Install — cache all legacy assets and activate immediately. /dist/* is
// not pre-cached; the wallet loader populates WALLET_CACHE lazily on first
// use, and content-hashed filenames make explicit cache-busting unnecessary.
self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(LEGACY_CACHE).then(cache =>
      Promise.all(
        STATIC_FILES.map(url =>
          fetch(url, { cache: "reload" }).then(res => cache.put(url, res))
        )
      )
    )
  );
  self.skipWaiting();
});

// Activate — delete previous legacy caches (combined `depix-vN` from before
// the split, and older `depix-legacy-vN` from prior releases). Preserves
// `depix-wallet` so a CSS-only deploy no longer evicts the 5 MB wallet bundle.
self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.map(key =>
          LEGACY_CACHE_RX.test(key) && key !== LEGACY_CACHE
            ? caches.delete(key)
            : null
        )
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

// Best-effort cleanup of stale hashed wallet artifacts. Called after a
// successful manifest fetch; deletes any /dist/{wallet-bundle,lwk_wasm}_*
// entry whose filename is no longer referenced by the live manifest. Never
// touches the manifest itself or other cache entries. Failures are swallowed.
async function gcWalletCache(manifest) {
  const cache = await caches.open(WALLET_CACHE);
  const keep = new Set(
    [manifest.walletBundle, manifest.walletWasm]
      .filter(Boolean)
      .map(rel => new URL(`./${rel}`, self.location).pathname)
  );
  const reqs = await cache.keys();
  await Promise.all(
    reqs.map(req => {
      const p = new URL(req.url).pathname;
      if (!/^\/dist\/(wallet-bundle-|lwk_wasm_bg-|lwk_wasm-).*\.(js|wasm)$/.test(p)) {
        return null;
      }
      return keep.has(p) ? null : cache.delete(req);
    })
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
          caches.open(LEGACY_CACHE).then(cache => cache.put(req, clone));
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Wallet manifest — network-first into WALLET_CACHE. Manifest points the
  // loader at the current content-hashed bundle filename; a stale cached
  // manifest would reference a filename that no longer exists on the server
  // after a wallet-only deploy. Falls back to cache when offline.
  // Triggers GC of old hashed entries opportunistically (non-blocking).
  if (url.pathname === "/dist/manifest.json") {
    event.respondWith(
      fetch(req, { cache: "no-cache" })
        .then(response => {
          if (response.ok) {
            const cacheClone = response.clone();
            const gcClone = response.clone();
            caches.open(WALLET_CACHE).then(cache => cache.put(req, cacheClone));
            gcClone.json().then(json => gcWalletCache(json)).catch(() => {});
          }
          return response;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // Wallet bundle + WASM — cache-first into WALLET_CACHE (content-hashed
  // filename, so a new build always produces a new URL). Timeout on the
  // network fallback so a stalled cellular fetch does not block wallet
  // init forever.
  //
  // On cold install + timeout the fetch rejects with AbortError; we catch it
  // and synthesize a 504 Response so the loader can branch on response.ok /
  // response.status instead of unwrapping a raw reject.
  if (url.pathname.startsWith("/dist/") && /\.(wasm|js)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then(cached => {
        if (cached) return cached;
        return fetchWithTimeout(req, WASM_FETCH_TIMEOUT_MS)
          .then(response => {
            if (response.ok) {
              const clone = response.clone();
              caches.open(WALLET_CACHE).then(cache => cache.put(req, clone));
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
            caches.open(LEGACY_CACHE).then(cache => cache.put(req, clone));
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
          caches.open(LEGACY_CACHE).then(cache => cache.put(req, clone));
        }
        return response;
      });
    })
  );
});
