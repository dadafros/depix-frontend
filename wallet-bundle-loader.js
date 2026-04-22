// Wallet bundle loader — the ONE file in the repo root that knows how to
// reach the esbuild output in `dist/`. Kept unbundled so `index.html` and
// `script.js` can import it with plain ES modules (no build step on the
// legacy side of the app).
//
// The loader:
//   1. Reads `./dist/manifest.json` (emitted by `build.mjs`) to discover the
//      content-hashed bundle filename for the current build.
//   2. Dynamic-imports the hashed bundle (a plain ES module).
//   3. Memoizes the namespace so repeated callers share one instance.
//
// Failures propagate as-is — the caller (script.js) decides whether to
// render a degraded UI or prompt for retry. We never silently return null.

let bundlePromise = null;

async function fetchManifest() {
  const res = await fetch("./dist/manifest.json", { cache: "no-cache" });
  if (!res.ok) {
    throw new Error(`wallet manifest unreachable (HTTP ${res.status})`);
  }
  return res.json();
}

async function loadOnce() {
  const manifest = await fetchManifest();
  const entry = manifest.walletBundle;
  if (!entry) {
    throw new Error("wallet manifest missing walletBundle entry");
  }
  // `entry` is a project-relative path like "dist/wallet-bundle-<hash>.js",
  // emitted by build.mjs. Resolve against the loader's own URL so it works
  // both at the site root and in the Docker dev volume.
  const url = new URL(`./${entry}`, import.meta.url).href;
  return import(/* @vite-ignore */ url);
}

/**
 * Load the wallet bundle namespace. Returns the module's exports
 * (createWalletModule, getDefaultWallet, registerWalletRoutes, WalletError,
 * ERROR_CODES, isWalletError, WALLET_BUNDLE_VERSION).
 */
export async function loadWalletBundle() {
  if (!bundlePromise) {
    bundlePromise = loadOnce().catch(err => {
      bundlePromise = null;
      throw err;
    });
  }
  return bundlePromise;
}
