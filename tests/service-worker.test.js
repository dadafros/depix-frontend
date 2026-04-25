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
    function buildScope() {
      const handlers = {};
      const deletedKeys = [];

      const fakeCaches = {
        keys: async () => [
          "depix-v138",
          "depix-v140",
          "depix-legacy-v140",
          "depix-legacy-v141",
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
      expect(handlers.activate).toBeTypeOf("function");

      let waitPromise;
      const fakeEvent = {
        waitUntil: p => { waitPromise = p; }
      };
      handlers.activate(fakeEvent);
      await waitPromise;

      // depix-legacy-v141 is the current cache (APP_VERSION=141), so it
      // must NOT be deleted. depix-wallet is preserved unconditionally.
      expect(deletedKeys.sort()).toEqual(
        ["depix-legacy-v140", "depix-v138", "depix-v140"].sort()
      );
      expect(deletedKeys).not.toContain("depix-wallet");
      expect(deletedKeys).not.toContain("depix-legacy-v141");
      expect(deletedKeys).not.toContain("unrelated-cache");

      cleanup();
    });
  });
});
