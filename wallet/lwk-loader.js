// Lazy-loader for lwk_wasm. Singleton semantics: the WASM module is only
// instantiated once per page-load. Subsequent callers await the same promise.
//
// Why the manual dance instead of just `import("lwk_wasm")`:
//
//   `lwk_wasm/lwk_wasm.js` is wasm-pack's "bundler" target. It does
//   `import * as wasm from "./lwk_wasm_bg.wasm"` at module top-level — which
//   neither esbuild nor the browser can satisfy for a separately-served WASM
//   file. We'd need a dedicated wasm-pack "web" build to avoid this. Since we
//   use the published npm package, we bypass `lwk_wasm.js` entirely:
//
//     - import the wasm-bindgen JS glue from `lwk_wasm/lwk_wasm_bg.js` (safe,
//       no top-level WASM import);
//     - import the .wasm binary with esbuild's `file` loader, which copies it
//       into `dist/` with a content-hash and gives us back the URL string;
//     - at runtime, fetch + `WebAssembly.instantiate(bytes, { "./lwk_wasm_bg.js": bg })`,
//       call `__wbg_set_wasm(instance.exports)`, then `__wbindgen_start()`.
//
// The result: all the classes (`Mnemonic`, `Signer`, `Wollet`, etc.) exported
// by `lwk_wasm_bg.js` become fully functional and can be used normally.

import { WalletError, ERROR_CODES } from "./wallet-errors.js";
import {
  LOAD_BACKOFF_SCHEDULE_MS,
  MAX_LOAD_RETRIES,
  WASM_FETCH_TIMEOUT_MS
} from "./constants.js";

import * as lwkBg from "lwk_wasm/lwk_wasm_bg.js";
// esbuild's `file` loader rewrites this to the hashed URL at build time.
import lwkWasmUrl from "lwk_wasm/lwk_wasm_bg.wasm";

let loadPromise = null;

function fetchWithTimeout(url, ms, fetchImpl) {
  const f = fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return f(url, { signal: controller.signal }).finally(() =>
    clearTimeout(timer)
  );
}

async function instantiate(url, fetchImpl) {
  const response = await fetchWithTimeout(url, WASM_FETCH_TIMEOUT_MS, fetchImpl);
  if (!response.ok) {
    throw new Error(`WASM fetch failed: HTTP ${response.status}`);
  }
  const bytes = await response.arrayBuffer();
  const imports = { "./lwk_wasm_bg.js": lwkBg };
  const { instance } = await WebAssembly.instantiate(bytes, imports);
  lwkBg.__wbg_set_wasm(instance.exports);
  if (typeof instance.exports.__wbindgen_start === "function") {
    instance.exports.__wbindgen_start();
  }
  return lwkBg;
}

async function tryLoad(url, fetchImpl, delayImpl) {
  const sleep = delayImpl ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_LOAD_RETRIES; attempt++) {
    try {
      return await instantiate(url, fetchImpl);
    } catch (err) {
      lastErr = err;
      const delay = LOAD_BACKOFF_SCHEDULE_MS[attempt] ?? 0;
      if (attempt < MAX_LOAD_RETRIES - 1 && delay > 0) {
        await sleep(delay);
      }
    }
  }
  throw new WalletError(
    ERROR_CODES.LWK_LOAD_FAILED,
    "Failed to load LWK WASM after retries",
    lastErr
  );
}

// Call once; returns the lwk_wasm_bg namespace (all the classes). Subsequent
// calls return the cached promise — no repeat fetch, no repeat instantiate.
export function loadLwk({ url, fetchImpl, delayImpl } = {}) {
  if (loadPromise) return loadPromise;
  // esbuild's `file` loader emits a bare relative filename for the WASM
  // import (e.g. "lwk_wasm_bg-<hash>.wasm"). If we fetch that string
  // directly, the browser resolves it against the DOCUMENT URL, not the
  // bundle URL — a page at "/" then requests "/lwk_wasm_bg-...wasm" and
  // gets the SPA fallback (index.html) back, which fails WASM validation
  // with "Failed to load LWK WASM after retries". Resolve against this
  // module's own URL so the request lands on "/dist/lwk_wasm_bg-...wasm".
  // Absolute URLs passed by tests (e.g. "fake://wasm") are preserved —
  // `new URL` ignores the base when the first arg is already absolute.
  const effectiveUrl = new URL(url ?? lwkWasmUrl, import.meta.url).href;
  loadPromise = tryLoad(effectiveUrl, fetchImpl, delayImpl).catch(err => {
    // Reset on failure so the next call retries; otherwise a transient cold-
    // start failure would permanently brick the wallet until reload.
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

// Test hook — drop the cached promise so a subsequent `loadLwk()` re-runs.
// Exported under an underscore-prefix name to flag internal use.
export function _resetForTesting() {
  loadPromise = null;
}

export { lwkBg as _lwkBgForTesting };
