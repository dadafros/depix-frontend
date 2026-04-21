import { describe, it, expect } from "vitest";
import {
  WalletError,
  ERROR_CODES,
  isWalletError
} from "../wallet/wallet-errors.js";

describe("WalletError", () => {
  it("is an Error subclass with a code", () => {
    const err = new WalletError(ERROR_CODES.WRONG_PIN, "bad pin");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WalletError);
    expect(err.code).toBe("WRONG_PIN");
    expect(err.message).toBe("bad pin");
    expect(err.name).toBe("WalletError");
  });

  it("falls back to the code when message is missing", () => {
    const err = new WalletError(ERROR_CODES.WALLET_NOT_FOUND);
    expect(err.message).toBe("WALLET_NOT_FOUND");
  });

  it("preserves the cause when provided", () => {
    const root = new Error("root cause");
    const err = new WalletError(ERROR_CODES.WRONG_PIN, "wrapped", root);
    expect(err.cause).toBe(root);
  });

  it("does not set cause when undefined", () => {
    const err = new WalletError(ERROR_CODES.WRONG_PIN, "no cause");
    expect("cause" in err).toBe(false);
  });
});

describe("ERROR_CODES", () => {
  it("enumerates every code used by the module", () => {
    const expected = [
      "WALLET_NOT_FOUND",
      "WALLET_ALREADY_EXISTS",
      "WALLET_LOCKED",
      "WALLET_WIPED",
      "WRONG_PIN",
      "WEAK_PIN",
      "PIN_RATE_LIMITED",
      "INVALID_MNEMONIC",
      "DESCRIPTOR_MISMATCH",
      "INSUFFICIENT_FUNDS",
      "BROADCAST_FAILED",
      "ESPLORA_UNAVAILABLE",
      "BIOMETRIC_UNAVAILABLE",
      "BIOMETRIC_REJECTED",
      "LWK_LOAD_FAILED",
      "STORAGE_UNAVAILABLE",
      "UNKNOWN"
    ];
    for (const code of expected) {
      expect(ERROR_CODES[code]).toBe(code);
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });
});

describe("isWalletError", () => {
  it("matches a WalletError without a code filter", () => {
    const err = new WalletError(ERROR_CODES.WRONG_PIN);
    expect(isWalletError(err)).toBe(true);
  });

  it("matches only the given code when one is passed", () => {
    const err = new WalletError(ERROR_CODES.WRONG_PIN);
    expect(isWalletError(err, ERROR_CODES.WRONG_PIN)).toBe(true);
    expect(isWalletError(err, ERROR_CODES.WALLET_WIPED)).toBe(false);
  });

  it("returns false for plain Errors", () => {
    expect(isWalletError(new Error("boom"))).toBe(false);
    expect(isWalletError(null)).toBe(false);
    expect(isWalletError("nope")).toBe(false);
  });
});
