// Single error class for every wallet failure. Consumers discriminate via
// `err.code` string literals. One class avoids the boilerplate of N Error
// subclasses for what is effectively a tagged union.
//
// When adding a new code, also add it to ERROR_CODES below so typos fail fast.

export const ERROR_CODES = Object.freeze({
  WALLET_NOT_FOUND: "WALLET_NOT_FOUND",
  WALLET_ALREADY_EXISTS: "WALLET_ALREADY_EXISTS",
  WALLET_LOCKED: "WALLET_LOCKED",
  WALLET_WIPED: "WALLET_WIPED",
  WRONG_PIN: "WRONG_PIN",
  WEAK_PIN: "WEAK_PIN",
  PIN_RATE_LIMITED: "PIN_RATE_LIMITED",
  INVALID_MNEMONIC: "INVALID_MNEMONIC",
  DESCRIPTOR_MISMATCH: "DESCRIPTOR_MISMATCH",
  INVALID_ADDRESS: "INVALID_ADDRESS",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  UNSUPPORTED_ASSET: "UNSUPPORTED_ASSET",
  SENDALL_NOT_SUPPORTED: "SENDALL_NOT_SUPPORTED",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  INSUFFICIENT_LBTC_FOR_FEE: "INSUFFICIENT_LBTC_FOR_FEE",
  BROADCAST_FAILED: "BROADCAST_FAILED",
  ESPLORA_UNAVAILABLE: "ESPLORA_UNAVAILABLE",
  ESPLORA_RATE_LIMITED: "ESPLORA_RATE_LIMITED",
  BIOMETRIC_UNAVAILABLE: "BIOMETRIC_UNAVAILABLE",
  BIOMETRIC_REJECTED: "BIOMETRIC_REJECTED",
  LWK_LOAD_FAILED: "LWK_LOAD_FAILED",
  STORAGE_UNAVAILABLE: "STORAGE_UNAVAILABLE",
  UNKNOWN: "UNKNOWN"
});

export class WalletError extends Error {
  constructor(code, message, cause) {
    super(message ?? code);
    this.name = "WalletError";
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export function isWalletError(err, code) {
  if (!(err instanceof WalletError)) return false;
  if (code === undefined) return true;
  return err.code === code;
}
