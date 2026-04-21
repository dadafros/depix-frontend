// Wallet bundle entry point. Sub-fase 1 ships this as a stub so the esbuild
// pipeline has something to bundle and the CI deploy stays green before the
// real module lands.
//
// Sub-fase 2 replaces the body with actual wallet exports (createWallet,
// restoreWallet, unlock, buildAndSignTx, broadcast, etc.) — see
// PLANO-FASE-1-WALLET.md. Do NOT import lwk_wasm here yet; Sub-fase 2
// introduces the lazy loader.

export const WALLET_BUNDLE_VERSION = "sub1-stub";

export function hasWallet() {
  return false;
}
