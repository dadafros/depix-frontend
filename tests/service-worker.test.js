// @vitest-environment node
//
// Smoke tests for the service-worker.js cache-policy split.
//
// service-worker.js runs in a Service Worker realm — it cannot be imported
// from a Vitest module test as-is (uses `self`, `caches`, `clients`). Instead
// we load it as text, parse out the parts we care about (the cache-name regex
// and the activate handler), and exercise them in a controlled scope.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SW_PATH = fileURLToPath(new URL("../service-worker.js", import.meta.url));
const SW_SOURCE = readFileSync(SW_PATH, "utf8");

function extractRegex() {
  // Pull `const LEGACY_CACHE_RX = /.../;` out of the source and reconstruct it.
  const m = SW_SOURCE.match(/const\s+LEGACY_CACHE_RX\s*=\s*\/(.+?)\/(\w*)\s*;/);
  if (!m) throw new Error("LEGACY_CACHE_RX literal not found in service-worker.js");
  return new RegExp(m[1], m[2]);
}

function extractAppVersion() {
  // Pull `const APP_VERSION = N;` so the activate-handler test can compute
  // the expected current cache name dynamically and stays correct across
  // future bumps without anyone editing this file.
  const m = SW_SOURCE.match(/const\s+APP_VERSION\s*=\s*(\d+)\s*;/);
  if (!m) throw new Error("APP_VERSION literal not found in service-worker.js");
  return parseInt(m[1], 10);
}

describe("service-worker cache policy", () => {
  describe("LEGACY_CACHE_RX", () => {
    const rx = extractRegex();

    it("matches pre-split combined caches (depix-vN)", () => {
      expect(rx.test("depix-v1")).toBe(true);
      expect(rx.test("depix-v138")).toBe(true);
      expect(rx.test("depix-v140")).toBe(true);
    });

    it("matches new legacy caches (depix-legacy-vN)", () => {
      expect(rx.test("depix-legacy-v141")).toBe(true);
      expect(rx.test("depix-legacy-v999")).toBe(true);
    });

    it("does NOT match the wallet cache", () => {
      expect(rx.test("depix-wallet")).toBe(false);
      expect(rx.test("depix-wallet-v1")).toBe(false);
    });

    it("does NOT match unrelated caches", () => {
      expect(rx.test("workbox-precache-v1")).toBe(false);
      expect(rx.test("depix-v")).toBe(false);
      expect(rx.test("depix-")).toBe(false);
      expect(rx.test("")).toBe(false);
    });
  });

  describe("activate handler", () => {
    // Build a minimal scope where service-worker.js can be evaluated without
    // a real ServiceWorkerGlobalScope. We only need to capture handler
    // registrations and run the activate handler against a mocked caches API.
    const APP_VERSION = extractAppVersion();
    const CURRENT_LEGACY_CACHE = `depix-legacy-v${APP_VERSION}`;
    // Older keys the activate handler should delete. All numeric values are
    // expressed relative to `APP_VERSION` so the test stays valid through
    // future bumps without editing this file.
    const OLD_LEGACY_KEYS = [
      `depix-v${APP_VERSION - 3}`,        // pre-split combined, very old
      `depix-v${APP_VERSION - 1}`,        // pre-split combined, last
      `depix-legacy-v${APP_VERSION - 1}`  // post-split, prior release
    ];

    function buildScope() {
      const handlers = {};
      const deletedKeys = [];

      const fakeCaches = {
        keys: async () => [
          ...OLD_LEGACY_KEYS,
          CURRENT_LEGACY_CACHE,
          "depix-wallet",
          "unrelated-cache"
        ],
        delete: async key => {
          deletedKeys.push(key);
          return true;
        },
        open: async () => ({ put: async () => {}, match: async () => null, keys: async () => [] }),
        match: async () => null
      };

      const scope = {
        addEventListener: (event, fn) => { handlers[event] = fn; },
        skipWaiting: () => {},
        clients: { claim: () => {} },
        location: new URL("https://depixapp.com/"),
        caches: fakeCaches
      };

      // service-worker.js refers to bare `caches`, `fetch`, `Response`,
      // `URL`, `AbortController`, `setTimeout`, `clearTimeout`. The latter
      // are inherited from globalThis; `caches` is not, so wire it via
      // `globalThis.caches` for the scope of this evaluation.
      const prevCaches = globalThis.caches;
      const prevFetch = globalThis.fetch;
      globalThis.caches = fakeCaches;
      globalThis.fetch = async () => new Response("", { status: 200 });

      // Wrap source in a function bound to our scope. Using `with` is
      // intentional here: the SW source uses `self.addEventListener`,
      // `self.skipWaiting`, `self.clients` — `with(scope)` makes those
      // resolve to our mock without a textual rewrite.
      const runner = new Function(
        "self",
        `with (self) { ${SW_SOURCE} }`
      );
      runner(scope);

      // Restore globals so other tests don't inherit the mocks.
      const cleanup = () => {
        globalThis.caches = prevCaches;
        globalThis.fetch = prevFetch;
      };

      return { handlers, deletedKeys, cleanup };
    }

    it("deletes legacy caches except the current one and preserves the wallet cache", async () => {
      const { handlers, deletedKeys, cleanup } = buildScope();
      try {
        expect(handlers.activate).toBeTypeOf("function");

        let waitPromise;
        const fakeEvent = {
          waitUntil: p => { waitPromise = p; }
        };
        handlers.activate(fakeEvent);
        await waitPromise;

        // The current LEGACY_CACHE (whatever APP_VERSION is at the time
        // this test runs) must NOT be deleted. `depix-wallet` and any
        // unrelated cache are preserved unconditionally.
        expect(deletedKeys.sort()).toEqual([...OLD_LEGACY_KEYS].sort());
        expect(deletedKeys).not.toContain("depix-wallet");
        expect(deletedKeys).not.toContain(CURRENT_LEGACY_CACHE);
        expect(deletedKeys).not.toContain("unrelated-cache");
      } finally {
        cleanup();
      }
    });
  });

  describe("gcWalletCache", () => {
    // Pull `async function gcWalletCache(manifest) { ... }` out of the
    // source and re-instantiate it in isolation so we can call it directly,
    // matching the extract-and-eval pattern used for LEGACY_CACHE_RX.
    function extractGcWalletCache() {
      const m = SW_SOURCE.match(/async function gcWalletCache\(manifest\)\s*\{[\s\S]*?\n\}/m);
      if (!m) throw new Error("gcWalletCache not found in service-worker.js");
      return m[0];
    }

    function buildGc(initialUrls, walletCacheName = "depix-wallet") {
      const stored = new Map(initialUrls.map(url => [url, { url }]));
      const cache = {
        keys: async () => Array.from(stored.values()),
        delete: async req => stored.delete(req.url)
      };
      const fakeCaches = {
        open: async name => {
          if (name !== walletCacheName) {
            throw new Error(`unexpected caches.open(${name})`);
          }
          return cache;
        }
      };
      const fakeSelf = { location: new URL("https://depixapp.com/") };
      const runner = new Function(
        "caches", "self", "WALLET_CACHE",
        `${extractGcWalletCache()}\nreturn gcWalletCache;`
      );
      return { gc: runner(fakeCaches, fakeSelf, walletCacheName), stored };
    }

    it("preserves entries referenced by the manifest and deletes the rest", async () => {
      const { gc, stored } = buildGc([
        "https://depixapp.com/dist/manifest.json",
        "https://depixapp.com/dist/wallet-bundle-CURRENT.js",
        "https://depixapp.com/dist/wallet-bundle-OLD.js",
        "https://depixapp.com/dist/lwk_wasm_bg-CURRENT.wasm",
        "https://depixapp.com/dist/lwk_wasm_bg-OLD.wasm"
      ]);

      await gc({
        walletBundle: "dist/wallet-bundle-CURRENT.js",
        walletWasm: "dist/lwk_wasm_bg-CURRENT.wasm"
      });

      expect(Array.from(stored.keys()).sort()).toEqual([
        "https://depixapp.com/dist/lwk_wasm_bg-CURRENT.wasm",
        "https://depixapp.com/dist/manifest.json",
        "https://depixapp.com/dist/wallet-bundle-CURRENT.js"
      ]);
    });

    it("never touches the manifest itself", async () => {
      const { gc, stored } = buildGc([
        "https://depixapp.com/dist/manifest.json",
        "https://depixapp.com/dist/wallet-bundle-OLD.js"
      ]);

      await gc({ walletBundle: "dist/wallet-bundle-NEW.js", walletWasm: null });

      expect(stored.has("https://depixapp.com/dist/manifest.json")).toBe(true);
      expect(stored.has("https://depixapp.com/dist/wallet-bundle-OLD.js")).toBe(false);
    });

    it("ignores /dist entries that don't match the wallet artifact pattern", async () => {
      const { gc, stored } = buildGc([
        "https://depixapp.com/dist/wallet-bundle-OLD.js",
        "https://depixapp.com/dist/foo-XYZ.js"
      ]);

      await gc({ walletBundle: "dist/wallet-bundle-NEW.js", walletWasm: null });

      expect(stored.has("https://depixapp.com/dist/foo-XYZ.js")).toBe(true);
      expect(stored.has("https://depixapp.com/dist/wallet-bundle-OLD.js")).toBe(false);
    });

    it("handles a missing walletWasm field without deleting the bundle", async () => {
      const { gc, stored } = buildGc([
        "https://depixapp.com/dist/wallet-bundle-CURRENT.js",
        "https://depixapp.com/dist/lwk_wasm_bg-OLD.wasm"
      ]);

      await gc({ walletBundle: "dist/wallet-bundle-CURRENT.js", walletWasm: null });

      expect(stored.has("https://depixapp.com/dist/wallet-bundle-CURRENT.js")).toBe(true);
      expect(stored.has("https://depixapp.com/dist/lwk_wasm_bg-OLD.wasm")).toBe(false);
    });
  });
});
