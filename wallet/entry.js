// Wallet bundle entry point — this is the file esbuild bundles.
//
// Anything exported from here is reachable by `script.js` via the dynamic
// import of the hashed bundle (see `dist/manifest.json`). Keep the surface
// area tight: the rest of the app imports `getDefaultWallet()` and the error
// types; the factory `createWalletModule` is available for tests that need
// to inject mocks.
//
// Sub-fase 2 wires the module + crypto + store + biometric + lwk loader. UI
// (Sub-fase 3) and send/receive (Sub-fase 4+) consume these exports.

export {
  createWalletModule,
  getDefaultWallet
} from "./wallet.js";

export {
  WalletError,
  ERROR_CODES,
  isWalletError
} from "./wallet-errors.js";

export { registerWalletRoutes } from "./wallet-ui.js";

export {
  ASSETS,
  DISPLAY_ORDER,
  isKnownAsset,
  getAssetByIdentifier,
  satsToAmount,
  satsToDecimalNumber,
  convertSatsToBrl,
  formatAssetAmount
} from "./asset-registry.js";

export {
  createQuotesClient,
  getDefaultQuotesClient
} from "./quotes.js";

export const WALLET_BUNDLE_VERSION = "sub4";
